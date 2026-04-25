# Security Guidelines

## Environment Variables

All sensitive information such as API keys, secrets, and credentials should be loaded from environment variables rather than being hardcoded in source code.

### Example usage:
```typescript
const apiKey = process.env.PRIVATE_API_KEY;
if (!apiKey) {
  throw new Error('PRIVATE_API_KEY environment variable is required');
}
```

### Setting up environment variables:
- For local development: Create a `.env` file in the project root (add to `.gitignore`)
- For production: Configure through your deployment platform's environment variables

## AWS Credentials

For AWS operations, we should rely on IAM roles attached to the Lambda function rather than hardcoded credentials.