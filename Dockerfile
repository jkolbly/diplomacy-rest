# syntax=docker/dockerfile:1

FROM node:latest

WORKDIR /app

COPY package.json package-lock.json /app/

RUN npm install

COPY . .