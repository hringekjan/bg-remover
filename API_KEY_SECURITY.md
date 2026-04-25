# Klaviyo API Key Security

## Overview

The bg-remover service requires a Klaviyo API key for certain operations. This document outlines the proper method for providing this key at runtime without hardcoding it in the repository.

## Secure Configuration

### Environment Variables (Recommended)

The Klaviyo API key should be provided via environment variables in the deployment configuration:

```bash
# In your deployment environment
export KLAVIYO_API_KEY="your-klaviyo-api-key-here"
```

### Serverless Framework Configuration

In your `serverless.yml`, configure the environment variable:

```yaml
provider:
  name: aws
  runtime: nodejs18.x
  environment:
    KLAVIYO_API_KEY: ${env:KLAVIYO_API_KEY}
```

### AWS Systems Manager Parameter Store (For Production)

For production deployments, consider storing the API key in AWS SSM Parameter Store:

```yaml
provider:
  name: aws
  runtime: nodejs18.x
  environment:
    KLAVIYO_API_KEY: ${ssm:/bg-remover/klaviyo-api-key}
```

Then retrieve it in your code:

```typescript
const klaviyoApiKey = process.env.KLAVIYO_API_KEY || await getParameterFromSSM('/bg-remover/klaviyo-api-key');
```

## Security Notes

1. **Never commit API keys** to version control
2. **Use environment variables** for different environments (dev, staging, prod)
3. **Rotate keys regularly** according to your security policy
4. **Restrict access** to only necessary services and personnel

## Development Setup

Create a `.env.example` file with placeholder values:

```bash
KLAVIYO_API_KEY=your-klaviyo-api-key-here
```

When deploying locally or to development environments, ensure the environment variable is set.