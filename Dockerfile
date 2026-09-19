FROM node:22-alpine

WORKDIR /app

# 仅安装生产依赖（pg-mem 为本地测试依赖，不进镜像）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY db ./db
COPY public ./public

EXPOSE 8130

# 等待数据库就绪 → 幂等写入种子数据 → 启动服务
CMD ["sh", "-c", "node db/seed.js && node src/server.js"]
