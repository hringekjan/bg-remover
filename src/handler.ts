import { bgRemoverHandler } from '../../carousel-api/src/handlers/bg-remover';
import { authorizeUser } from './middleware/auth';
import { healthCheck } from './health';
// other imports...

export const handler = async (event) => {
  const response = await someMiddleware(event);
  return response;
};