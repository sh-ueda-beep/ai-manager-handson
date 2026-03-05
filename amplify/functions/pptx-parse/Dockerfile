FROM public.ecr.aws/lambda/nodejs:22-arm64
COPY package.json ./
RUN npm install
COPY handler.ts pptx-parser.ts ./
RUN npx tsc --module nodenext --moduleResolution nodenext --target es2022 --esModuleInterop --skipLibCheck --outDir /var/task handler.ts pptx-parser.ts
CMD ["handler.handler"]
