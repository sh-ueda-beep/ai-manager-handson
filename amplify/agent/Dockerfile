FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY *.ts ./

EXPOSE 8080

CMD ["npx", "tsx", "app.ts"]
