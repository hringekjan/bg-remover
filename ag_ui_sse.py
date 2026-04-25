from fastapi import FastAPI, HTTPException, Depends
from fastapi.responses import StreamingResponse
import asyncio
import json
from typing import AsyncGenerator
import logging

# Configure logging
logger = logging.getLogger(__name__)

app = FastAPI(title="Background Remover UI SSE Service")

async def generate_events() -> AsyncGenerator[str, None]:
    """Generate server-sent events"""
    try:
        while True:
            # Simulate some data processing
            data = {
                "event": "update",
                "data": {"message": "Processing image...", "progress": 50},
                "timestamp": asyncio.get_event_loop().time()
            }
            
            yield f"data: {json.dumps(data)}\n\n"
            await asyncio.sleep(1)
            
    except Exception as e:
        logger.error(f"Error in event generation: {str(e)}")
        data = {
            "event": "error",
            "data": {"message": str(e)},
            "timestamp": asyncio.get_event_loop().time()
        }
        yield f"data: {json.dumps(data)}\n\n"

@app.get("/sse/ui")
async def ui_sse():
    """SSE endpoint for UI updates"""
    try:
        return StreamingResponse(generate_events(), media_type="text/plain")
    except Exception as e:
        logger.error(f"Error in SSE endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)