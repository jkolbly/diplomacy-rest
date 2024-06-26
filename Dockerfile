# syntax=docker/dockerfile:1

FROM node:12.18.4-alpine

WORKDIR /app

COPY package.json package-lock.json /app/

RUN npm install

COPY . .