# Diplomacy REST API

REST API for Diplomacy hosted on [Bankbook](http://bankbook.kolbly.name/).

Okay so it's not actually RESTful but gimme a break.

## Endpoints

Endpoints are relative to [http://bankbook.kolbly.name/diplomacy/api](http://bankbook.kolbly.name/diplomacy/api). The browser accessing this API must have a valid `auth_token` cookie.

If there's an error during a request on any endpoint, the server will send a response of the form `{"error":"{description}"}`.

| Endpoint | GET/POST | GET Params | Content-Type | Request Body | Description |
|---|---|---|---|---|---|
| /maps | GET | | | | Redirects to /maps/list. |
| /maps/list | GET | | | | Get a list of paths to maps. |
| /maps/list-details | GET | | | | Get a list of maps as objects with keys `filename`, `name`, and `players` (list of integers representing possible player counts for the map). |
| /maps/{path} | GET | | | | Redirects to /maps/{path}/data. | 
| /maps/{path}/data | GET | | | | Get the JSON contents of the .dipmap file representing a map. {path} is the same as the string under the key `map` in a game JSON. | 
| /maps/{path}/image | GET | | | | Get the image file linked in the .dipmap file found at {path}. |
| /maps/{path}/transparency/{id} | GET | | | | Get the image or svg file for province {id} linked in the .dipmap file found at {path}. |
| /games/list | GET | | | | Get a JSON list containing the number ID's of every game involving the user. |
| /games/list-details | GET | | | | Like /games/list but returns a list of objects with keys `id`, `gameName`, `mapName`, `playerFirstNames` (list of strings), `phase`, `season`, and `winner`. This is the information needed to display the list of a user's games on the browser. |
| /games/new | POST | | application/x-www-form-urlencoded | name<br/>map<br/>users | Create a new game and get its number ID. |
| /games/{id}/view | GET | | | | Get the JSON representation of a game (some parts of the game, such as orders submitted by other players on the current turn, are excluded to avoid potential cheating). |
| /games/{id}/delete | POST | | | | "Delete" a game by tagging it as deleted, and get a boolean representing whether the deletion was successful. |
| /games/{id}/submit-orders | POST | | application/json | JSON list of orders | Submit a list of orders, and get a boolean representing whether the submission was successful. |
| /games/{id}/claim-country | POST | | application/x-www-form-urlencoded | country | Claim a country or group of countries for a user. If claiming a group of countries, post the ID of _one_ of the countries. |
| /users/{username} | GET | | | | Get information about a user as an object with keys `username`, `firstname`, `lastname`, `type`, `email`. Works for all Bankbook users, not just Diplomacy users. |

## Development

To run a docker container with live reloading, compose [docker-compose.dev.yml](docker-compose.dev.yml):

    docker-compose -f docker-compose.dev.yml up

Append `--build` to rebuild the Docker image entirely. This is needed when modifying dependencies because `npm install` is run when building the image and not when running the image.

## Apache Instructions

To use Apache as a proxy for this server, make sure the module `mod_proxy_http` is enabled:

    LoadModule proxy_http_module modules/mod_proxy_http.so

Set up the proxy pass:

    <Location "/diplomacy/api/">
        ProxyPass "http://localhost:8000/"
        ProxyPassReverse "/"
    </location>

Note: I have no clue how the `ProxyPassReverse "/"` line works, but it was necessary to change it from `ProxyPassReverse "http://localhost:8000/"` to allow the Express server to redirect with urls starting with `/`.