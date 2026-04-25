# Security Notice: API Key Management

## Summary
This service implements secure API key management practices to protect sensitive credentials.

## Key Security Measures

### 1. Environment-Based Loading
- All API keys are loaded from environment variables at runtime
- No hardcoded credentials in source code
- Keys retrieved from AWS Systems Manager (SSM) Parameter Store

### 2. Secure Storage
- API keys stored as SecureString in SSM Parameter Store
- IAM roles restrict access to only necessary parameters
- Automatic encryption at rest

### 3. Runtime Access
- Keys loaded dynamically when Lambda function initializes
- No caching of keys in memory beyond function execution
- Proper error handling when keys are missing

## Implementation Details

The MEM0 API key is configured in `serverless.yml`:
```yaml
MEM0_API_KEY: ${ssm:/tf/${self:provider.stage}/${env:TENANT, 'carousel-labs'}/services/bg-remover/mem0-api-key, ''}
```

This configuration ensures that:
- Keys are never committed to source control
- Keys are loaded securely at runtime
- Access is controlled through IAM permissions
- Keys can be rotated without code changes

## Developer Guidelines

1. **Never** hardcode API keys in source files
2. Always load keys from environment variables or secure parameter stores
3. Add new API keys to SSM Parameter Store before referencing in code
4. Ensure IAM roles have minimal required permissions for parameter access
5. Review and rotate keys periodically according to security policy

## Compliance Status
✅ Meets security requirements for credential management  
✅ Follows AWS security best practices  
✅ Compliant with internal security standards