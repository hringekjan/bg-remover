import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { httpResponse, errorResponse } from '../utils/response';
import { extractAuthContext } from '../utils/auth';

export const healthCheck = async (): Promise<APIGatewayProxyResultV2> => {
    try {
        const authContext = extractAuthContext();
        // Here you can perform health checks against other services if needed.
        return httpResponse(200, { message: 'Service is healthy', authContext });
    } catch (error) {
        return errorResponse(500, 'Health check failed');
    }
};