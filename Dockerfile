FROM node:20-bullseye-slim

# Install ffmpeg, python3, curl, unzip for audio processing and youtube-dl
RUN apt-get update && apt-get install -y ffmpeg python3 curl unzip && rm -rf /var/lib/apt/lists/*

# Install deno globally for yt-dlp JS execution
RUN curl -fsSL https://deno.land/install.sh | sh
ENV PATH="/root/.deno/bin:${PATH}"

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm install

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY . .

# Build TypeScript code
RUN npm run build

# Expose API port
EXPOSE 3001

# Start the server
CMD ["npm", "run", "start"]
