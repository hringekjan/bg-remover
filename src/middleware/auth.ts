import { extractAuthContext, isAdmin, isStaff, isSuperAdmin } from '../utils/auth';

export const authorizeUser = async (requiredRole: string) => {
  const authContext = extractAuthContext();

  if (requiredRole === 'admin' && !isAdmin(authContext)) {
    throw new Error('User is not authorized as admin.');
  } else if (requiredRole === 'staff' && !isStaff(authContext) && !isAdmin(authContext)) {
    throw new Error('User is not authorized as staff.');
  } else if (requiredRole === 'superAdmin' && !isSuperAdmin(authContext)) {
    throw new Error('User is not authorized as super admin.');
  }
  return authContext;
};
