# Diplomacy REST API

REST API for Diplomacy hosted on [Bankbook](http://bankbook.kolbly.name/).

## Endpoints

Endpoints are relative to [http://bankbook.kolbly.name:8000/diplomacy/api](http://bankbook.kolbly.name:8000/diplomacy/api). The browser accessing this API must have a valid `auth_token` cookie.

| Endpoint | GET/POST | GET Params | Content-Type | Request Body | Description |
|---|---|---|---|---|---|
| /maps/list | GET | | | | Get a list of maps as objects with keys `filename`, `name`, and `players` (list of integers representing possible player counts for the map). |
| /games/list | GET | | | | Get a JSON list containing the number ID's of every game involving the user. |
| /games/list-details | GET | | | | Like /games/list but returns a list of objects with keys `id`, `gameName`, `mapName`, `playerFirstNames` (list of strings), `phase`, `season`, and `winner`. This is the information needed to display the list of a user's games on the browser. |
| /games/new | POST | | application/x-www-form-urlencoded | name<br/>map<br/>users | Create a new game and get its number ID. |
| /games/{id}/view | GET | | | | Get the JSON representation of a game (some parts of the game, such as orders submitted by other players on the current turn, are excluded to avoid potential cheating). |
| /games/{id}/delete | POST | | | | "Delete" a game by tagging it as deleted, and get a boolean representing whether the deletion was successful. |
| /games/{id}/submit-orders | POST | | application/json | JSON list of orders | Submit a list of orders, and get a boolean representing whether the submission was successful. |
| /games/{id}/claim-country | POST | | application/x-www-form-urlencoded | country | Claim a country or group of countries for a user. If claiming a group of countries, post the ID of _one_ of the countries. |

## Development

To run a docker container with live reloading, compose [docker-compose.dev.yml](docker-compose.dev.yml):

    docker-compose -f docker-compose.dev.yml up --build