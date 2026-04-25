# BG Remover Service

Background remover service for processing images.

## Deployment

```bash
npm install
serverless deploy
```

## Environment Variables

- `REGION`: AWS region (defaults to us-east-1)
- `S3_BUCKET`: S3 bucket for storing processed images