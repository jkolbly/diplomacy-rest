const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const utils = require("./diplomacy-server-utils.js");
const tests = require("./tests.js");

const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

sql.mysql_connect(process.env.DB_UPSTREAM, utils.config.SQL_USER, utils.config.SQL_PASSWORD, utils.config.SQL_DATABASE);

/**
 * @param {(username:string,req:express.Request,res:express.Response,)=>} authenticated
 * @param {(req:express.Request,res:express.Response)=>} denied
 * @param {string[]} body_params List of required body parameters.
 * @returns {(req:express.Request,res:express.Response)=>Promise} Calls `authenticated` if user is authenticated, `denied` otherwise.
 */
function generic_auth_func(authenticated, denied=default_deny, body_params=[]) {
  return async (req, res) => {
    try {
      let [auth, username] = await sql.authenticate(req, "diplomacy");
      for (let param of body_params) {
        if (!Object.keys(req.body).includes(param)) {
          throw Error(`Missing required POST param ${param}.`);
        }
      }
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
 * Same as `generic_auth_func` but also makes sure user has permission to view/edit this particular game and passes the ServerGameData object to `authenticated`
 * @param {(username:string,gameData:utils.ServerGameData,req:express.Request,res:express.Response)=>} authenticated 
 * @param {(req:express.Request,res:express.Response)=>} denied 
 * @returns {(req:express.Request,res:express.Response)=>Promise}
 */
function generic_game_auth_func(authenticated, denied=default_deny, body_params=[]) {
  return generic_auth_func(async (username, req, res) => {
    let gameData = await utils.gamedata_from_id(req.params.id);
    if (gameData.users.includes(username)) {
      await authenticated(username, gameData, req, res);
    } else {
      await denied(req, res);
    }
  }, denied, body_params);
}

/**
 * @param {express.Request} req 
 * @param {express.Response} res 
 */
function default_deny(req, _) {
  console.log(`Unauthorized access from ${req.ip}`);
  throw Error("Unauthorized access.");
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

app.get("/games", generic_auth_func(async (username, req, res) => {
  res.redirect("/games/list");
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
}, default_deny, ["name", "map", "users"]));

app.get("/games/:id", generic_auth_func(async (username, req, res) => {
  res.redirect(`/games/${req.params.id}/view`);
}));

app.get("/games/:id/view", generic_game_auth_func(async (username, gameData, req, res) => {
  res.send(gameData.sanitized(username));
}));

app.post("/games/:id/delete", generic_game_auth_func(async (username, gameData, req, res) => {
  gameData.archive();
  res.send("true");
}));

app.post("/games/:id/claim-country", generic_game_auth_func(async (username, gameData, req, res) => {
  gameData.claim_country(username, req.body.country);
  gameData.save();
  res.send("true");
}, default_deny, ["country"]));

app.post("/games/:id/submit-orders", generic_game_auth_func(async (username, gameData, req, res) => {
  for (let order of req.body) gameData.submit_order(username, shared.import_order(order));
  gameData.save();
  res.send("true");
}));

app.get("/games/:id/valid-orders/:province", generic_game_auth_func(async (username, gameData, req, res) => {
  res.send(gameData.get_valid_orders(gameData.get_unit(req.params.province)).map(order => order.export()));
}));

app.get("/users/:username", generic_auth_func(async (username, req, res) => {
  res.send(await sql.user_data(req.params.username));
}));

app.get("/tests/run/:test(*)", generic_auth_func(async (username, req, res) => {
  let test = await tests.load_test(req.params.test);
  await test.run();
  res.send({
    gameData: test.gameData.sanitized(),
    logs: test.logs
  });
}));

app.get("/tests/run-datc", generic_auth_func(async (username, req, res) => {
  let test_paths = await utils.get_datc_list();
  console.log(tests);
  let results = {};
  for (let t of test_paths) {
    let test = await tests.load_test(t);
    for await (let _ of test.generator) { // estlint
      for (let log of test.lastLogs) {
        if (log.level == "error") {
          results[t] = "fail";
          break;
        }
      }
    }
    if (!results[t]) results[t] = "pass";
  }
  res.send(results);
}));

app.get("/tests/list", generic_auth_func(async (username, req, res) => {
  res.send(await utils.get_test_list());
}));

app.listen(process.env.SERVER_PORT, () => { console.log(`Listening on port ${process.env.SERVER_PORT}`); });