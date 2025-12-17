FROM public.ecr.aws/lambda/nodejs:22-arm64

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built application
COPY .next ./.next

# Copy additional necessary files
COPY lib ./lib
COPY public ./public

# Lambda Handler
CMD [".next/server/app/api/process/route.handler"]
