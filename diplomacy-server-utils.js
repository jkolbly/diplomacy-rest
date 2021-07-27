const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const fs = require("fs").promises;
const util = require("util");
const path = require("path");

/**
 * Get map data from a uri relative to ./maps
 * @param {Promise<string>} rel 
 * @returns {shared.MapInfo}
 */
async function get_map_info(rel) {
  return JSON.parse(await fs.readFile(path.join("maps", rel)));
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
    json.mapInfo = await get_map_info(json.map);
    return new ServerGameData(json);
  }
  return false;
}


/**
 * Server-specific information and methods about a game
 */
class ServerGameData extends shared.GameData {

}

exports.ServerGameData = ServerGameData;
exports.gamedata_from_id = gamedata_from_id;