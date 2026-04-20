FROM node:20-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 8080

# APP_MODE controla qué servicio arranca:
#   web  → La Gran Bancolombia (portal bancario)
#   bot  → QuindBot (WhatsApp + Vertex)
# En Cloud Run se inyecta via --set-env-vars APP_MODE=web|bot
CMD ["sh", "-c", "if [ \"$APP_MODE\" = 'web' ]; then node server.js; else node app.js; fi"]