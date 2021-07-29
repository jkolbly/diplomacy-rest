const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const utils = require("./diplomacy-server-utils.js");

const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

sql.mysql_connect(process.env.DB_UPSTREAM);

/**
 * @param {(username:string,req:express.Request,res:express.Response,)=>} authenticated
 * @param {(req:express.Request,res:express.Response)=>} denied
 * @returns {(req:express.Request,res:express.Response)=>Promise} Calls `authenticated` if user is authenticated, `denied` otherwise.
 */
function generic_auth_func(authenticated, denied=default_deny) {
  return async (req, res) => {
    try {
      let [auth, username] = await sql.authenticate(req, "diplomacy");
      if (auth) {
        await authenticated(username, req, res);
      } else {
        await denied(req, res);
      }
    } catch (error) {
      console.error(error);
      res.status(500).send({error: error.message});
    }
  };
}

/**
 * @param {express.Request} req 
 * @param {express.Response} res 
 */
function default_deny(req, res) {
  res.send("Unauthorized use");
  console.log(`Unauthorized access from ${req.ip}`);
}

app.get("/maps", generic_auth_func(async (username, req, res) => {
  res.redirect("/maps/list");
}));

app.get("/maps/list", generic_auth_func(async (username, req, res) => {
  res.send(await utils.get_map_list());
}));

app.get("/maps/list-details", generic_auth_func(async (username, req, res) => {
  let arr = [];
  for await (let val of (await utils.get_map_list()).map(async (f) => { return await utils.get_map_overview(f); })) {
    arr.push(val);
  }
  res.send(arr);
}));

app.get("/maps/:path(*)/data", generic_auth_func(async (username, req, res) => {
  res.send(await utils.get_map_info(req.params.path));
}));

app.get("/maps/:path(*)/image", generic_auth_func(async (username, req, res) => {
  let mapInfo = await utils.get_map_info(req.params.path);
  res.sendFile(path.resolve("maps", path.dirname(req.params.path), mapInfo.info.image));
}));

app.get("/maps/:path(*)/transparency/:id", generic_auth_func(async (username, req, res) => {
  let mapInfo = await utils.get_map_info(req.params.path);
  let province = mapInfo.provinces.find(p => p.id == req.params.id);
  if (province) {
    res.sendFile(path.resolve("maps", path.dirname(req.params.path), province.transparency));
  } else {
    throw Error(`That province doesn't exist.`);
  }
}));

app.get("/maps/:path(*)", generic_auth_func(async (username, req, res) => {
  res.redirect(path.join("/maps", req.params.path, "data"));
}));

app.get("/games/list", generic_auth_func(async (username, req, res) => {
  res.send((await utils.get_game_list(username)).map((gameData) => gameData.id));
}));

app.get("/games/list-details", generic_auth_func(async (username, req, res) => {
  let arr = [];
  for await (let details of (await utils.get_game_list(username)).map(async (gameData) => gameData.get_game_overview())) {
    arr.push(details);
  }
  res.send(arr);
}));

app.post("/games/new", generic_auth_func(async (username, req, res) => {
  let gameData = await utils.new_game(username, req.body.name, req.body.map, req.body.users.split(","));
  gameData.save();
  res.send(gameData.id.toString());
}));

app.get("/games/:id", generic_auth_func(async (username, req, res) => {
  res.redirect(`/games/${req.params.id}/view`);
}));

app.get("/games/:id/view", generic_auth_func(async (username, req, res) => {
  res.send((await utils.gamedata_from_id(req.params.id)).sanitized(username));
}));

app.post("/games/:id/delete", generic_auth_func(async (username, req, res) => {
  (await utils.gamedata_from_id(req.params.id)).archive();
  res.send("true");
}));

app.get("/users/:username", generic_auth_func(async (username, req, res) => {
  res.send(await sql.user_data(req.params.username));
}));

app.listen(process.env.SERVER_PORT, () => { console.log(`Listening on port ${process.env.SERVER_PORT}`); });