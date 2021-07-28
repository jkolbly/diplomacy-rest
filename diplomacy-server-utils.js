const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const fs = require("fs").promises;
const util = require("util");
const path = require("path");

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
  console.log({
    filename: rel,
    name: map.info.name,
    players: Object.keys(map.playerConfigurations).map((n) => Number(n))
  });
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
 * @returns {Promise<ServerGameData|boolean>} 
 */
async function gamedata_from_id(id) {
  let rows = await sql.query("SELECT json FROM diplomacy_games WHERE id=?", id);
  if (rows.length > 0) {
    let json = JSON.parse(rows[0].json);
    return await create_gamedata(json);
  }
  return false;
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
 * Server-specific information and methods about a game
 */
class ServerGameData extends shared.GameData {
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
      phase: this.state.phase,
      season: this.state.season,
      winner: this.winner ? (await sql.user_data(this.winner)).firstname : ""
    };
  }
}

exports.ServerGameData = ServerGameData;
exports.get_game_list = get_game_list;
exports.gamedata_from_id = gamedata_from_id;
exports.get_map_list = get_map_list;
exports.get_map_overview = get_map_overview;
exports.get_map_info = get_map_info;