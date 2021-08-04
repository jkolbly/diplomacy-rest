const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const fssync = require("fs");
const fs = fssync.promises;
const util = require("util");
const path = require("path");

/**
 * The config data loaded from ./config.
 */
const config = {};

// Read the config file ./config and save its data to config.
(function() {
  let raw = fssync.readFileSync("./config").toString();

  for (let line of raw.split("\n")) {
    let [key, val] = line.split("=");
    config[key.trim()] = val.trim();
  }
})();

/**
 * @param {string} rootPath 
 * @param {RegExp} regex To match against file names or false to get all files.
 */
async function* get_files_recursive(rootPath, regex=false) {
  let filenames = await fs.readdir(rootPath);
  for (let filename of filenames) {
    const p = path.resolve(rootPath, filename);
    if ((await fs.stat(p)).isDirectory()) {
      yield* get_files_recursive(p, regex);
    } else if (!regex || regex.test(filename)) {
      yield p;
    }
  }
}

/**
 * Get a list of paths to .dipmap files relative to ./maps
 * @returns {Promise<string[]>}
 */
async function get_map_list() {
  let list = [];
  for await (let file of get_files_recursive("maps", /^.*\.dipmap/)) list.push(path.relative("maps", file));
  return list;
}

/**
 * Get an object with basic info about a map.
 * @param {path} rel Relative to ./maps
 * @returns {Promise<{filename:string,name:string,players:number[]}>}
 */
async function get_map_overview(rel) {
  let map = await get_map_info(rel);
  return {
    filename: rel,
    name: map.info.name,
    players: Object.keys(map.playerConfigurations).map((n) => Number(n))
  }
}

/**
 * Get map data from a uri relative to ./maps
 * @param {Promise<string>} rel 
 * @returns {Promise<shared.MapInfo>}
 */
async function get_map_info(rel) {
  return JSON.parse(await fs.readFile(path.join("maps", rel)));
}

/**
 * Get the list of JSON representations of games involving `username`
 * @param {string} username Username or empty for no username checking.
 * @returns {Promise<ServerGameData[]>} 
 */
async function get_game_list(username="") {
  let rows = await sql.query("SELECT json FROM diplomacy_games WHERE archived=FALSE");
  let list = [];
  for (let row of rows) {
    let json = JSON.parse(row.json);
    if (!username || json.users.includes(username)) {
      list.push(await create_gamedata(json));
    }
  }
  return list;
}

/**
 * Get a ServerGameData object from a game's ID or false if no such game exists.
 * @param {number} id
 * @returns {Promise<ServerGameData>} 
 */
async function gamedata_from_id(id) {
  let rows = await sql.query("SELECT json FROM diplomacy_games WHERE id=?", id);
  if (rows.length > 0) {
    let json = JSON.parse(rows[0].json);
    return await create_gamedata(json);
  }
  throw Error(`No game found with ID ${id}.`);
}

/**
 * Return whether or not a game exists with this ID.
 * @param {number} id 
 * @returns {Promise<boolean>}
 */
async function game_exists(id) {
  return (await sql.query("SELECT id FROM diplomacy_games WHERE id=?", id)).length > 0;
}

/**
 * Create a ServerGameData object from a JSON object and get map data from the SQL server.
 * @param {Object} json JSON object without map data. This object gets modified in the process.
 * @returns {Promise<ServerGameData>}
 */
async function create_gamedata(json) {
  json.mapInfo = await get_map_info(json.map);
  return new ServerGameData(json);
}

/**
 * Create a new ServerGameData object from scratch. Throws an error if:
 *  - mapPath is invalid
 *  - The requesting user isn't one of the listed users
 *  - A user doesn't have permission to play Diplomacy
 *  - A user doesn't exist
 *  - The number of players is invalid for the map
 * @param {string} user
 * @param {string} gameName 
 * @param {string} mapPath 
 * @param {string[]} usernames 
 * @returns {Promise<ServerGameData>}
 */
async function new_game(user, gameName, mapPath, usernames) {
  let data = {};

  if (!usernames.includes(user)) {
    throw Error("You can't create a game you're not part of.");
  }

  do {
    data.id = randint(0, 1000000000);
  } while (await game_exists(data.id));

  data.name = gameName;
  data.map = mapPath;
  data.users = usernames;
  data.winner = "";
  data.won = shared.winStateEnum.Playing;
  data.phase = shared.phaseEnum["Country Claiming"];

  for (let user of usernames) {
    if (!(await sql.user_app_permission(user, "diplomacy"))) {
      throw Error(`User ${user} doesn't have permission to play Diplomacy.`);
    }
  }

  data.mapInfo = await get_map_info(mapPath);

  if (!Object.keys(data.mapInfo.playerConfigurations).includes(usernames.length.toString())) {
    throw Error(`${usernames.length} is an invalid number of players for this map.`);
  }
  let playerConfig = data.mapInfo.playerConfigurations[usernames.length.toString()];

  data.history = [{
    date: data.mapInfo.info.date,
    season: shared.seasonEnum.Spring,
    nations: {}
  }];

  data.players = {};

  for (let country of data.mapInfo.countries) {
    let eliminated = playerConfig.eliminate.includes(country.id);
    if (!eliminated) {
      data.players[country.id] = "";
    }

    if (playerConfig.neutralEliminate || !eliminated) {
      let units = [];

      for (let supplyCenter of country.supplyCenters) {
        let province = data.mapInfo.provinces.find(p => p.id == supplyCenter);
        if (province.startUnit > 0) {
          units.push({
            type: province.startUnit - 1,
            province: supplyCenter,
            coast: (province.startUnit - 1 == shared.unitTypeEnum.Fleet && !province.water) ? province.coasts.find(c => c.frigateStart).id : ""
          });
        }
      }

      data.history[0].nations[country.id] = {
        id: country.id,
        supplyCenters: country.supplyCenters,
        units: units,
        neutral: eliminated
      }
    }
  }

  return new ServerGameData(data);
}

/**
 * @param {number} min 
 * @param {number} max 
 * @returns {number} Pseudo-random integer n such that min <= n < max
 */
function randint(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Used as a replacer function for JSON.stringify when stringifying ServerGameData objects.
 */
function gamedata_stringify_replacer(key, val) {
  return val instanceof shared.Order ? val.export() : val
}

/**
 * Server-specific information and methods about a game
 */
class ServerGameData extends shared.GameData {
  constructor(json) {
    super(json);

    this.mapInfo.provinces = this.mapInfo.provinces.filter(p => !this.eliminatedProvinces.includes(p.id));
    this.mapInfo.countries = this.mapInfo.countries.filter(c => Object.keys(this.state.nations).includes(c.id));
    this.mapInfo.routes = this.mapInfo.routes.filter(r => !this.eliminatedProvinces.includes(r.p0) && !this.eliminatedProvinces.includes(r.p1));
  }

  /**
   * A list of province ID's that are eliminated from the game.
   * Value gets cached.
   * @type {string[]}
   */
  get eliminatedProvinces() {
    Object.defineProperty(this, "eliminatedProvinces", { value: [] });
    if (!this.playerConfig.neutralEliminate) {
      for (let country of this.playerConfig.eliminate) {
        this.eliminatedProvinces.push(...this.get_country(country).supplyCenters);
      }
    }
    return this.eliminatedProvinces;
  }

  /**
   * Get an object with basic info about a game.id, gameName, mapName, playerFirstNames (list of strings), phase, season, and winner
   * @returns {Promise<{id:number,gameName:string,mapName:string,playerFirstNames:string[],phase:number,season:number,winner:string}>}
   */
  async get_game_overview() {
    let firstNames = [];
    for (let username of this.users) {
      firstNames.push((await sql.user_data(username)).firstname);
    }
    return {
      id: this.id,
      gameName: this.name,
      mapName: this.mapInfo.info.name,
      playerFirstNames: firstNames,
      phase: this.phase,
      season: this.state.season,
      winner: this.winner ? (await sql.user_data(this.winner)).firstname : ""
    };
  }

  /**
   * Save this game to the SQL server
   */
  async save() {
    let toStore = ["phase", "id", "name", "map", "users", "players", "winner", "won", "history"].reduce((obj, key) => { obj[key] = this[key]; return obj; }, {});
    
    let stringified = JSON.stringify(toStore, gamedata_stringify_replacer);

    if (await game_exists(this.id)) {
      sql.query("UPDATE diplomacy_games SET json=? WHERE id=?", [stringified, this.id]);
    } else {
      sql.query("INSERT INTO diplomacy_games (id, json) VALUES (?, ?)", [this.id, stringified]);
    }
  }

  /**
   * Tag this game as archived in the SQL server
   */
  async archive() {
    await sql.query("UPDATE diplomacy_games SET archived=TRUE WHERE id=?", [this.id]);
  }

  /**
   * Get an object with a version of this game that can safely be shown to a user without revealing information.
   * Also removes unused parts of the map.
   * @param {string} username
   * @returns {Object}
   */
  sanitized(username) {
    let obj = ["phase", "id", "name", "map", "users", "players", "winner", "won", "history", "mapInfo"].reduce((obj, key) => { obj[key] = this[key]; return obj; }, {});
    obj = JSON.parse(JSON.stringify(obj, gamedata_stringify_replacer));

    for (let country in this.state.orders) {
      if (this.country_owner(country) != username) {
        delete obj.history[obj.history.length - 1].orders[country];
      }
    }
    for (let country in this.state.retreats) {
      if (this.country_owner(country) != username) {
        delete obj.history[obj.history.length - 1].retreats[country];
      }
    }
    for (let country in this.state.adjustments) {
      if (this.country_owner(country) != username) {
        delete obj.history[obj.history.length - 1].adjustments[country];
      }
    }

    return obj;
  }

  /**
   * Claim a country for a user. If the input country is part of a country group, claim all countries in the group.
   * @param {string} username 
   * @param {string} country 
   */
  claim_country(username, country) {
    if (this.phase != shared.phaseEnum["Country Claiming"]) throw Error("You can't claim a country after the game has started.");

    let group = this.country_group(country);
    if (!group) throw Error(`Country ${country} is not selectable.`);
    if (group.find(c => this.players[c] && this.players[c] != username)) throw Error("You can't claim a country that's already been claimed.");

    for (let c in this.players) {
      if (group.includes(c)) {
        this.players[c] = username;
      } else if (this.players[c] == username) {
        this.players[c] = "";
      }
    }

    if (!(Object.values(this.players).some(p => !p))) {
      this.start_order_writing();
    }
  }

  /**
   * Check if an order is valid and save it as submitted if so.
   * @param {string} username Username of user trying to submit order.
   * @param {shared.Order} order Order to be submitted.
   */
  submit_order(username, order) {
    let unit = this.get_unit(order.province);

    if (!unit) throw Error(`There is no unit at ${order.province}.`);
    if (this.get_unit_owner_player(order.province) != username) throw Error(`User ${username} has no control over unit at ${order.province}.`);

    if (order.type == shared.orderTypeEnum.cancel) {
      delete this.state.orders[this.get_unit_owner_id(unit.province)][unit.province];
    } else {
      if (!this.get_valid_orders(unit).some(o => o.id == order.id)) throw Error(`Order ${order.id} is not valid.`);

      this.state.orders[this.get_unit_owner_id(unit.province)][unit.province] = order;
    }
  }

  /**
   * Initiate the order writing phase and set the value of `this.phase`.
   */
  start_order_writing() {
    this.state.orders = {};
    for (let c in this.players) {
      this.state.orders[c] = {};
    }
    this.phase = shared.phaseEnum["Order Writing"];
  }
}

exports.ServerGameData = ServerGameData;
exports.get_game_list = get_game_list;
exports.new_game = new_game;
exports.gamedata_from_id = gamedata_from_id;
exports.get_map_list = get_map_list;
exports.get_map_overview = get_map_overview;
exports.get_map_info = get_map_info;
exports.config = config;