FROM node:20-alpine

# simple-git shells out to the system git binary at runtime (repo cloning)
RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["./start.sh"]
