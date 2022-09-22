const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const fssync = require("fs");
const fs = fssync.promises;
const path = require("path");

/**
 * Enum for storing the state of an order within the adjudication process.
 * @readonly
 * @enum {number}
 */
const resolutionStateEnum = {
  Unresolved: 0,
  Guessing: 1,
  Resolved: 2
}

/**
 * Enum for storing a type of backup rule needing to be processed.
 * @readonly
 * @enum {number}
 */
const backupRuleType = {
  circle: 0,
  convoy: 1
}

/**
 * The config data loaded from ./config.
 */
const config = {};

// Read the config file ./config and save its data to config.
(function() {
  let raw = fssync.readFileSync("./config").toString();

  for (let line of raw.split("\n")) {
    let [key, val] = line.split("=");
    if (key && val) config[key.trim()] = val.trim();
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
 * Get a list of test files relative to ./tests
 * @returns {Promise<string[]>}
 */
async function get_test_list() {
  let list = [];
  for await (let file of get_files_recursive("tests")) list.push(path.relative("tests", file));
  return list;
}

/**
 * Get a list of DATC test files relative to ./tests
 * @returns {Promise<string[]>}
 */
 async function get_datc_list() {
  let list = [];
  for await (let file of get_files_recursive("tests/DATC")) list.push(path.relative("tests", file));
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
 * @param {boolean} checkUsers Whether to verify users have correct permissions.
 * @param {boolean} populate Whether to add the starting units.
 * @returns {Promise<ServerGameData>}
 */
async function new_game(user, gameName, mapPath, usernames, checkUsers=true, populate=true) {
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

  if (checkUsers) {
    for (let user of usernames) {
      if (!(await sql.user_app_permission(user, "diplomacy"))) {
        throw Error(`User ${user} doesn't have permission to play Diplomacy.`);
      }
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
      data.history[0].nations[country.id] = {
        id: country.id,
        supplyCenters: country.supplyCenters,
        units: [],
        neutral: eliminated
      }
    }
  }

  let gameData = new ServerGameData(data);
  if (populate) {
    gameData.populate();
  }
  return gameData;
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
  sanitized(username="", includeMapInfo=true) {
    let keys = ["phase", "id", "name", "map", "users", "players", "winner", "won", "history"];
    if (includeMapInfo) keys.push("mapInfo");
    let obj = keys.reduce((obj, key) => { obj[key] = this[key]; return obj; }, {});
    obj = JSON.parse(JSON.stringify(obj, gamedata_stringify_replacer));

    if (username) {
      if (this.phase == shared.phaseEnum["Order Writing"]) {
        for (let country in this.state.orders) {
          if (this.country_owner(country) != username) {
            delete obj.history[obj.history.length - 1].orders[country];
          }
        }
      } else if (this.phase == shared.phaseEnum.Retreating) {
        for (let country in this.state.retreats) {
          if (this.country_owner(country) != username) {
            delete obj.history[obj.history.length - 1].retreats[country];
          }
        }
      } else if (this.phase == shared.phaseEnum["Creating/Disbanding"]) {
        for (let country in this.state.adjustments) {
          if (this.country_owner(country) != username) {
            delete obj.history[obj.history.length - 1].adjustments[country];
          }
        }
      }
    }

    return obj;
  }

  /**
   * Spawn all the starting units for this game.
   */
  populate() {
    for (let c in this.state.nations) {
      this.state.nations[c].units = [];
      let country = this.get_country(c);

      for (let supplyCenter of country.supplyCenters) {
        let province = this.mapInfo.provinces.find(p => p.id == supplyCenter);
        if (province.startUnit > 0) {
          this.state.nations[c].units.push({
            type: province.startUnit - 1,
            province: supplyCenter,
            coast: (province.startUnit - 1 == shared.unitTypeEnum.Fleet && !province.water) ? province.coasts.find(c => c.frigateStart).id : ""
          });
        }
      }
    }
  }

  /**
   * Spawn a single unit at a province.
   * @param {string} country The nation ID of the nation which will own the spawned unit.
   * @param {string} province The province ID to spawn the unit at.
   * @param {shared.unitTypeEnum} type The type of unit to spawn.
   * @param {string} coast The coast to use for fleets spawning on a coastal province.
   * @param {boolean} force Remove the existing unit at `province` if one exists.
   * @returns {boolean} Whether or not a unit was summoned.
   */
  spawn_unit(country, province, type, coast="", force=false) {
    let unit  = this.get_unit(province);
    if (unit) {
      if (force) {
        this.remove_unit(province);
      } else {
        return false;
      }
    }

    let p = this.get_province_or_err(province);
    
    if (type == shared.unitTypeEnum.Fleet && p.coasts.length == 1) coast = p.coasts[0].id;

    if (type == shared.unitTypeEnum.Fleet && !p.water && p.coasts.length == 0) throw Error(`Tried to spawn fleet on landlocked province ${province}.`);
    if (type == shared.unitTypeEnum.Fleet && !p.water && !this.get_coast(province, coast)) throw Error(`Couldn't find coast ${coast} on province ${province}.`);
    if (type == shared.unitTypeEnum.Army && p.water) throw Error(`Tried to spawn army on water province ${province}.`);

    this.state.nations[country].units.push({
      type: type,
      province: province,
      coast: coast
    });

    return true;
  }

  /**
   * Remove the unit from a province if one exists.
   * @param {string} province The string ID of the province, presumably with a unit.
   * @returns {boolean} Whether a unit was removed.
   */
  remove_unit(province) {
    let unit = this.get_unit(province);
    if (unit) {
      let owner = this.get_unit_owner_id(province);
      this.state.nations[owner].units = this.state.nations[owner].units.filter(u => u.province != province);
      return true;
    }
    return false;
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
   * Check if a cancel order is valid and process it if so.
   * @param {string} username Username of the user trying to submit order.
   * @param {shared.CancelOrder} order Cancel order to be submitted.
   */
  submit_cancel_order(username, order) {
    switch (this.phase) {
      case shared.phaseEnum["Order Writing"]: {
        let unit = this.get_unit(order.province);
        if (!unit) throw Error(`There is no unit at ${order.province}.`);
        if (this.get_unit_owner_player(order.province) != username) throw Error(`User ${username} has no control over unit at ${order.province}.`);
        delete this.state.orders[this.get_unit_owner_id(unit.province)][unit.province];
        break;
      }
    }
  }

  /**
   * Check if an order for the order writing phase (hold, move, support, or convoy) is valid and submit it if so.
   * @param {string} username Username of the user trying to submit order.
   * @param {shared.Order} order Order to be submitted.
   */
  submit_normal_order(username, order) {
    if (this.phase != shared.phaseEnum["Order Writing"]) throw Error(`Cannot place an order during phase ${this.phase} (must be ${shared.phaseEnum["Order Writing"]})`);
        
    let unit = this.get_unit(order.province);
    if (!unit) throw Error(`There is no unit at ${order.province}.`);
    if (this.get_unit_owner_player(order.province) != username) throw Error(`User ${username} has no control over unit at ${order.province}.`);

    if (!this.get_valid_orders(unit).some(o => o.id == order.id)) throw Error(`Order ${order.id} is not valid.`);

    order.result = shared.orderResultEnum.unprocessed;

    this.state.orders[this.get_unit_owner_id(unit.province)][unit.province] = order;
  }

  /**
   * Check if a retreat is valid and submit it if so.
   * @param {string} username Username of the user trying to submit retreat.
   * @param {shared.RetreatOrder} retreat Retreat order to be submitted.
   */
  submit_retreat(username, retreat) {
    if (this.phase != shared.phaseEnum.Retreating) throw Error(`Cannot submit a retreat during phase ${this.phase} (must be ${shared.phaseEnum.Retreating})`);

    let prev_state = this.history[this.history.length - 2];
    let dislodgement = prev_state.dislodgements[retreat.province];

    if (!dislodgement) throw Error(`No unit was dislodged from ${retreat.province}`);
    if (this.country_owner(dislodgement.country) != username) throw Error(`User ${username} has no control over unit dislodged from ${retreat.province}`);
    if (!this.get_valid_retreats(dislodgement).some(r => r.id == retreat.id)) throw Error(`Retreat ${retreat.id} is not valid.`);

    retreat.result = shared.orderResultEnum.unprocessed;

    prev_state.retreats[dislodgement.country][dislodgement.unit.province] = retreat;
  }

  /**
   * Check if an adjustment order is valid and submit it if so.
   * @param {string} username 
   * @param {shared.AdjustOrder} order 
   */
  submit_adjust_order(username, order) {
    if (this.phase != shared.phaseEnum["Creating/Disbanding"]) throw Error(`Cannot submit an adjustment order during phase ${this.phase} (must be ${shared.phaseEnum["Creating/Disbanding"]})`);
    if (this.country_owner(order.country) != username) throw Error(`User ${username} has no control over country ${order.country}.`);

    let prev_state = this.history[this.history.length - 2];
    let to_build = prev_state.nations[order.country].toBuild;
    if (to_build == 0) throw Error(`Country ${order.country} cannot build or disband any units this turn.`);
    
    let valid_orders = to_build > 0
      ? this.get_valid_build_orders(order.country)
      : this.get_valid_disband_orders(order.country);
    if (!valid_orders.some(o => o.id == order.id)) throw Error(`Adjustment ${order.id} is not valid.`);

    let submitted = prev_state.adjustments[order.country];
    if (order.type != shared.orderTypeEnum.pass && submitted.some(o => o.id == order.id)) throw Error(`Adjustment order ${order.id} has already been submitted.`);

    // If the maximum number of adjustments has already been reached, overwrite a pass. If there is no submitted pass, throw an error.
    if (submitted.length >= Math.abs(to_build)) {
      let submitted_pass_index = submitted.findIndex(o => o.type == shared.orderTypeEnum.pass);
      if (submitted_pass_index > -1) {
        submitted.splice(submitted_pass_index, 1);
      } else {
        throw Error(`Country ${order.country} has already submitted its maximum number of adjustments.`);
      }
    }

    submitted.push(order);
  }

  /**
   * Check if an order is valid and save it as submitted if so.
   * @param {string} username Username of user trying to submit order.
   * @param {shared.Order} order Order to be submitted.
   */
  submit_order(username, order) {
    switch (order.type) {
      case shared.orderTypeEnum.cancel:
        this.submit_cancel_order(username, order);
        break;
      case shared.orderTypeEnum.retreat:
        this.submit_retreat(username, order);
        break;
      case shared.orderTypeEnum.build:
      case shared.orderTypeEnum.disband:
      case shared.orderTypeEnum.pass:
        this.submit_adjust_order(username, order);
        break;
      default: 
        this.submit_normal_order(username, order);
        break;
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

  /**
   * Create a new `State` object and prepare for the next turn's retreat phase.
   * 
   * NOTE: Retreat writing is the first phase in a turn.
   */
  start_retreat_writing() {
    /** @type {shared.State} */
    let newState = {};

    if (this.state.season == shared.seasonEnum.Fall) {
      newState.date = this.state.date + 1;
      newState.season = shared.seasonEnum.Spring;
    } else {
      newState.date = this.state.date;
      newState.season = shared.seasonEnum.Fall;
    }

    newState.nations = JSON.parse(JSON.stringify(this.state.nations));
    
    this.state.retreats = {};
    this.state.dislodgements = {};

    this.history.push(newState);

    this.phase = shared.phaseEnum.Retreating;
  }

  /**
   * Update which supply centers are owned by which countries based on the current position of units
   */
  update_supply_centers() {
    let supply_centers = this.get_supply_centers().map(province => province.id);

    for (let country in this.state.nations) {
      for (let unit of this.state.nations[country].units) {
        let province = unit.province;

        // Don't do anything if supply center ownership isn't changing
        if (supply_centers.includes(province) && !this.state.nations[country].supplyCenters.includes(province)) {
          // Remove this supply center from whoever previously owned it
          for (let c in this.state.nations) {
            let index = this.state.nations[c].supplyCenters.indexOf(province);
            if (index > -1) {
              this.state.nations[c].supplyCenters.splice(index, 1);
              break;
            }
          }

          // Add this supply center to the new owner's list
          this.state.nations[country].supplyCenters.push(province);
        }
      }
    }
  }

  /**
   * Prepare for the creating and disbanding units phase or skip it if this isn't the end of a Fall turn (i.e. the start of a Spring turn)
   */
  start_creating_and_disbanding() {
    if (this.state.season == shared.seasonEnum.Spring) {
      this.phase = shared.phaseEnum["Creating/Disbanding"];
      let prev_state = this.history[this.history.length - 2];

      this.update_supply_centers();

      for (let c in this.state.nations) {
        let supply_centers = this.state.nations[c].supplyCenters.length;
        let units = this.state.nations[c].units.length;
        prev_state.nations[c].toBuild = supply_centers - units;
      }

      prev_state.adjustments = Object.fromEntries(Object.keys(this.state.nations).filter(c => prev_state.nations[c].toBuild != 0).map(c => [c, []]));
    } else {
      this.start_order_writing();
    }
  }

  /**
   * Mark a unit as retreating by moving from the map to the `dislodgements` object.
   */
  make_unit_retreat(provinceId, attacker) {
    let unit = this.get_unit(provinceId);
    if (unit) {
      let prev_state = this.history[this.history.length - 2];
      let country = this.get_unit_owner_id(provinceId);
      prev_state.dislodgements[unit.province] = {
        unit: unit,
        from: attacker,
        country: country
      };
      if (!prev_state.retreats[country]) prev_state.retreats[country] = {};
      this.remove_unit(provinceId);
    }
  }

  /**
   * Adjudicate and apply all currently placed retreats (note that retreats are found on the second-to-last state).
   */
  calculate_retreats() {
    if (this.phase != shared.phaseEnum.Retreating) throw Error(`Can only process retreats during retreating phase.`);

    let prev_state = this.history[this.history.length - 2];
    let retreats = Object.values(prev_state.retreats).flatMap(c => Object.values(c));

    for (let retreat of retreats) {
      retreat.result = retreats.some(r => r.id != retreat.id && r.dest == retreat.dest)
        ? shared.orderResultEnum.fail
        : shared.orderResultEnum.success;

      if (retreat.result == shared.orderResultEnum.success) {
        let dislodgement = prev_state.dislodgements[retreat.province];

        /** @type {shared.Unit} */
        let new_unit = {
          province: retreat.dest,
          coast: retreat.coast,
          type: dislodgement.unit.type
        };

        this.state.nations[dislodgement.country].units.push(new_unit);
      }
    }

    this.start_creating_and_disbanding();
  }

  /**
   * Submit a hold order for every unit that doesn't have an order
   */
  fill_orders_with_holds() {
    for (let c in this.state.nations) {
      for (let u of this.state.nations[c].units) {
        if (!this.state.orders[c][u.province]) this.state.orders[c][u.province] = new shared.HoldOrder(u.province);
      }
    }
  }

  /**
   * Adjudicate and apply all currently placed orders and move on to retreat writing phase.
   */
  calculate_orders() {
    if (this.phase != shared.phaseEnum["Order Writing"]) throw Error("Can only adjudicate orders during order writing phase.");

    this.fill_orders_with_holds();

    let orders = Object.values(this.state.orders).map(nation => Object.values(nation)).reduce((arr, val) => { arr.push(...val); return arr; });

    /** @type {Object.<string,shared.Order[]>} */
    let dependencies = {};
    for (let order of orders) {
      dependencies[order.id] = this.get_dependencies(order, orders);
    }

    /** @type {resolutionStateEnum[]} */
    let resolutionStates = new Array(orders.length).fill(resolutionStateEnum.Unresolved);

    /** @type {boolean[]} */
    let resolutions = new Array(orders.length);

    /** @type {number[]} */
    let dep_list = [];

    let tabsize = 0;

    /**
     * @param {number} orderIndex
     */
    let resolve = (orderIndex) => {
      console.log(`${"  ".repeat(tabsize)}Resolving ${orders[orderIndex].id}`);
      tabsize += 1;
      // console.log("Resolution state for " + orders[orderIndex].id + ": " + resolutionStates[orderIndex]);
      switch (resolutionStates[orderIndex]) {
        case resolutionStateEnum.Resolved:
          console.log(`${"  ".repeat(tabsize)}Already resolved as ${resolutions[orderIndex]}`);
          tabsize -= 1;
          return resolutions[orderIndex];
        case resolutionStateEnum.Guessing:
          dep_list.push(orderIndex);
          console.log(`${"  ".repeat(tabsize)}Already guessed as ${resolutions[orderIndex]}`);
          tabsize -= 1;
          return resolutions[orderIndex];
        case resolutionStateEnum.Unresolved: {
          let old_dep_size = dep_list.length;

          resolutions[orderIndex] = false;
          resolutionStates[orderIndex] = resolutionStateEnum.Guessing;

          console.log(`${"  ".repeat(tabsize)}Guessing ${resolutions[orderIndex]} for ${orders[orderIndex].id}`);

          let adj_res = adjudicate(orderIndex);

          console.log(`${"  ".repeat(tabsize)}Adjudication result for ${orders[orderIndex].id}: ${adj_res}`);

          // No dependencies
          if (old_dep_size == dep_list.length) {
            console.log(`${"  ".repeat(tabsize)}No dependencies for ${orders[orderIndex].id}`);
            resolutionStates[orderIndex] = resolutionStateEnum.Resolved;
            resolutions[orderIndex] = adj_res;
            console.log(`${"  ".repeat(tabsize)}Returning ${adj_res} for ${orders[orderIndex].id}`);
            tabsize -= 1;
            return adj_res;
          }

          // Dependency, but doesn't depend on itself
          if (dep_list[old_dep_size] != orderIndex) {
            dep_list.push(orderIndex);
            resolutions[orderIndex] = adj_res;
            tabsize -= 1;
            return adj_res;
          }

          // Dependency on itself (cycle)

          // Set all dependencies to unresolved
          for (let i = dep_list.length - 1; i >= old_dep_size; i--) {
            resolutionStates[dep_list[i]] = resolutionStateEnum.Unresolved;
          }

          // Try again with other guess
          resolutions[orderIndex] = true;
          resolutionStates[orderIndex] = resolutionStateEnum.Guessing;

          console.log(`${"  ".repeat(tabsize)}Guessing ${resolutions[orderIndex]} for ${orders[orderIndex].id}`);

          let adj_res_2 = adjudicate(orderIndex);

          // Cycle only has one resolution
          if (adj_res == adj_res_2) {
            console.log(`${"  ".repeat(tabsize)}Cycle has only one resolution, where ${orders[orderIndex].id} resolves as ${adj_res}`);
            // Set all dependencies to unresolved
            for (let i = dep_list.length - 1; i >= old_dep_size; i--) {
              resolutionStates[dep_list[i]] = resolutionStateEnum.Unresolved;
            }

            resolutions[orderIndex] = adj_res;
            resolutionStates[orderIndex] = resolutionStateEnum.Resolved;
            tabsize -= 1;
            return adj_res;
          }

          // Cycle has two or no resolutions, pass to backup rule.
          // Clean up dependencies so that dep_list.length == old_dep_size
          // Dependencies should be set to Resolved or Unresolved.
          console.log(`${"  ".repeat(tabsize)}Cycle has zero or two resolutions`);
          backup_rule(old_dep_size);

          // Start over in case backup rule leaves some orders unresolved.
          tabsize -= 1;
          return resolve(orderIndex);
        }
      }
    };

    /** Return whether any convoy route succeeds for a convoy move order `order`. Also returns true if order is not a convoy movement. */
    let any_convoy_route = (order) => {
      // Convoys fail if any of the fleets can't convoy
      if (order.isConvoy) {
        for (let route of this.all_convoy_routes(orders, order.province, order.dest)) {
          let routeworks = true;
          for (let i of route) {
            if (!resolve(i)) {
              routeworks = false;
              break;
            }
          }
          if (routeworks) return true;
        }
        return false;
      }
      return true;
    }

    /**
     * @param {number} orderIndex
     */
    let adjudicate = (orderIndex) => {
      let order = orders[orderIndex];
      switch (order.type) {
        case shared.orderTypeEnum.hold:
          return true;
        case shared.orderTypeEnum["support hold"]:
        case shared.orderTypeEnum["support move"]:
          for (let i = 0; i < orders.length; i++) {
            let o = orders[i];
            // Cut support if attacked by a foreign power from any province other than the one being supported, except if the cutting unit is unsuccessfully convoyed
            if (o.type == shared.orderTypeEnum.move && o.dest == order.province && !this.same_team(o.province, order.province) && (o.province != order.supporting || resolve(i)) && any_convoy_route(o)) {
              return false;
            }
          }
          return true;
        case shared.orderTypeEnum.move: {
          if (!any_convoy_route(order)) return false;

          if (!contested.includes(order.dest)) contested.push(order.dest);

          /**
           * @param {shared.Order} ord
           */
          let strength = ord => orders.filter((o, i) => this.move_supports(ord, o) && resolve(i)).length;
          let strength_ignore_teams = ord => orders.filter((o, i) => this.move_supports_ignore_teams(ord, o) && resolve(i)).length;
          let def_strength = p => orders.filter((o, i) => this.hold_supports(p, o) && resolve(i)).length;

          // Hold strength is 0 if the destination is empty or contains a unit that successfully moves.
          // Hold strength is 1 if the destination contains a unit that is ordered to move but fails.
          // Otherwise, hold strength is 1 plus the number of units that support the unit to hold.
          let holding_unit = this.get_unit(order.dest);
          let holding_unit_move_order = orders.findIndex(o => o.type == shared.orderTypeEnum.move && o.province == order.dest);
          let hold_strength = !holding_unit || (holding_unit_move_order != -1 && resolve(holding_unit_move_order))
            ? 0 // Either no holding unit or the holding unit successfully moves
            : (holding_unit_move_order != -1
              ? 1 // Holding unit unsuccessfully moves
              : 1 + def_strength(order.dest)); // Hold strength is 1 plus number of supports to hold

          // Attack strength is 1 plus the number of movement supports if the destination is empty or there's no head-to-head battle and the destination unit successfully moves
          // Otherwise, attack strength is 0 if the unit at the destination is of the same nationality
          // Otherwise, attack strength is 1 plus the number of successfully supporting units that aren't the same nationality as the destination unit
          let is_hth_battle = holding_unit_move_order != -1 && !order.isConvoy && !orders[holding_unit_move_order].isConvoy && orders[holding_unit_move_order].dest == order.province;
          let attack_strength = !holding_unit || (!is_hth_battle && holding_unit_move_order != -1 && resolve(holding_unit_move_order))
            ? 1 + strength_ignore_teams(order) // Destination is empty or there's no head-to-head battle and the destination unit moves
            : (this.same_team(order.province, order.dest) && !(holding_unit_move_order != -1 && resolve(holding_unit_move_order))
              ? 0 // Attacking and defending units are on the same team
              : 1 + strength(order)); // Attack strength is 1 plus number of supports

          // Get orders that are competing for the same territory
          let other_attacks = orders.filter((o, i) => i != orderIndex && o.type == shared.orderTypeEnum.move && o.dest == order.dest);

          console.log(`${"  ".repeat(tabsize)}Attack strength: ${attack_strength}`);
          console.log(`${"  ".repeat(tabsize)}Hold strength: ${hold_strength}`);
          console.log(`${"  ".repeat(tabsize)}Is head-to-head battle? ${is_hth_battle}`);

          // If there's a head-to-head battle, calculate defend strength
          if (is_hth_battle) {
            // Defend strength is 1 plus the number of support orders
            let defend_strength = 1 + strength_ignore_teams(orders[holding_unit_move_order]);
            if (defend_strength >= attack_strength) return false;
          } else if (hold_strength >= attack_strength) {
            return false;
          }

          console.log(`${"  ".repeat(tabsize)}Other attacks from: ${other_attacks.map(o => o.province).join(", ")}`);

          for (let attack of other_attacks) {
            // Prevent strength is 0 if part of a head-to-head battle with a unit that successfully moves
            // Otherwise, prevent strength is 1 plus the number of successfully supporting units
            let successful_hth_order = orders.find((o, i) => o.type == shared.orderTypeEnum.move && o.province == attack.dest && o.dest == attack.province && !o.isConvoy && !attack.isConvoy && resolve(i));
            let prevent_strength = successful_hth_order || !any_convoy_route(attack) ? 0 : 1 + strength_ignore_teams(attack);
            console.log(`${"  ".repeat(tabsize)}Prevent strength for ${attack.id}: ${prevent_strength}`)
            if (prevent_strength >= attack_strength) return false;
          }

          return true;
        }
        case shared.orderTypeEnum.convoy:
          for (let i = 0; i < orders.length; i++) {
            let o = orders[i];
            if (o.type == shared.orderTypeEnum.move && o.dest == order.province && !this.same_team(o.province, order.province) && resolve(i)) {
              return false;
            }
          }
          return true;
      }
    };

    let backup_rule_type = (_dep_start_index) => {
      for (let i_dep = _dep_start_index; i_dep < dep_list.length; i_dep++) {
        let i = dep_list[i_dep];
        if (orders[i].type == shared.orderTypeEnum.move && orders.find(o => o.type == shared.orderTypeEnum.convoy && o.province == orders[i].dest)) {
          return backupRuleType.convoy;
        }
      }
      return backupRuleType.circle;
    }

    /**
     * @param {number} dep_start_index Index of first dependency in this cycle.
     */
    let backup_rule = (_dep_start_index) => {
      console.log(`${"  ".repeat(tabsize)}Entering backup rule`);
      console.log(`${"  ".repeat(tabsize)}Paradoxical cycle dependencies: ${dep_list.slice(_dep_start_index).map(i => orders[i].id).join(", ")}`);
      let type = backup_rule_type(_dep_start_index);
      for (let i_dep = dep_list.length - 1; i_dep >= _dep_start_index; i_dep--) {
        let i = dep_list[i_dep];
        if (type == backupRuleType.convoy && (orders[i].type == shared.orderTypeEnum.convoy || (orders[i].type == shared.orderTypeEnum.move && orders[i].isConvoy))) {
          resolutions[i] = false;
          resolutionStates[i] = resolutionStateEnum.Resolved;
          console.log(`${"  ".repeat(tabsize)}Setting ${orders[i].id} to fail to resolve paradox`);
        } else if (type == backupRuleType.circle && orders[i].type == shared.orderTypeEnum.move) {
          resolutions[i] = true;
          resolutionStates[i] = resolutionStateEnum.Resolved;
          console.log(`${"  ".repeat(tabsize)}Setting ${orders[i].id} to succeed to resolve paradox`);
        } else {
          resolutionStates[i] = resolutionStateEnum.Unresolved;
        }
        dep_list.pop();
      }
    }

    // Create new state object and prepare for applying adjudications.
    this.start_retreat_writing();

    console.log("\n----------Starting adjudication----------\n");

    /** Units to be dislodged. */
    let to_dislodge = [];

    /** Units that shouldn't be dislodged because they're moving. */
    let cannot_dislodge = [];

    /** Successful move orders to be executed simultaneously. */
    let successful_moves = [];

    /**
     * List of provinces that are contested.
     * @type {Array<string>}
     */
    let contested = [];

    for (let i = 0; i < orders.length; i++) {
      let order = orders[i];
      let success = resolve(i);

      if (success && order.type == shared.orderTypeEnum.move) {
        to_dislodge.push({ unit: order.dest, attacker: order.isConvoy ? "" : order.province });
        cannot_dislodge.push(order.province);

        successful_moves.push({
          unit: this.get_unit(order.province),
          dest: order.dest,
          coast: order.coast 
        });
      }

      order.result = success ? shared.orderResultEnum.success : shared.orderResultEnum.fail;

      console.log(`${"  ".repeat(tabsize + 1)}Does ${order.id} succeed? ${success}\n`);
    }

    let any_retreats = false;
    to_dislodge = to_dislodge.filter(d => !cannot_dislodge.includes(d.unit));
    for (let d of to_dislodge) {
      let dislodged_order = orders.find(o => o.province == d.unit);
      if (dislodged_order) {
        dislodged_order.result = shared.orderResultEnum.dislodged;

        this.make_unit_retreat(d.unit, d.attacker);

        any_retreats = true;
      }
    }

    for (let move of successful_moves) {
      move.unit.province = move.dest;
      move.unit.coast = move.coast;
    }

    // Contested provinces are provinces where at least two orders satisfy the following:
    //   - The order is not a convoy that failed because it didn't have a route (i.e. the province is already in "contested" array)
    //   - The order is a move order that failed to move
    //   - The order was not dislodged from where it was attempting to move
    let failed_moves = orders.filter(o => o.type == shared.orderTypeEnum.move && o.result != shared.orderResultEnum.success);
    contested = contested.filter(p => {
      if (!contested.includes(p)) return false;
      let attack_count = 0;
      for (let o of failed_moves) {
        if (o.result != shared.orderResultEnum.dislodged || !to_dislodge.some(d => d.unit == o.province && d.attacker == o.dest)) {
          attack_count += 1;
          if (attack_count >= 2) return true;
        }
      }
      return false;
    });
    this.history[this.history.length - 2].contested = contested;

    console.log("Ended adjudication");

    if (!any_retreats) this.start_creating_and_disbanding();
  }

  /**
   * Return whether `support` is an order supporting `order`.
   * @param {shared.Order} order Order to be supported.
   * @param {shared.Order} support Supporting order.
   * @returns {boolean} Whether `support` is a valid support order for `order`.
   */
  order_supports(order, support) {
    return (support.type == shared.orderTypeEnum["support hold"] && order.type != shared.orderTypeEnum.move && order.province == support.supporting)
      || (support.type == shared.orderTypeEnum["support move"] && order.type == shared.orderTypeEnum.move && order.dest == support.supporting && order.province == support.from && !this.same_team(order.dest, support.province));
  }

  /**
   * Return whether `support` is an order supporting a move order `move`.
   * @param {shared.Order} move Move order to be supported. This is assumed to be a move order.
   * @param {shared.Order} support Supporting order.
   * @returns {boolean} Whether `support` is a valid support order for `move`.
   */
  move_supports(move, support) {
    return this.move_supports_ignore_teams(move, support) && !this.same_team(move.dest, support.province);
  }

  /**
   * Return whether `support` is an order supporting a move order `move` without considering the teams of both units.
   * @param {shared.Order} move Move order to be supported. This is assumed to be a move order.
   * @param {shared.Order} support Supporting order.
   * @returns {boolean} Whether `support` is a valid support order for `move`.
   */
  move_supports_ignore_teams(move, support) {
    return support.type == shared.orderTypeEnum["support move"] && move.dest == support.supporting && move.province == support.from;
  }

  /**
   * Return whether `support` is an order supporting the unit in `province` to hold.
   * @param {string} province Province of unit to be supported.
   * @param {shared.Order} support Supporting order.
   * @returns {boolean} Whether `support` is a valid hold support for the unit at `province`.
   */
  hold_supports(province, support) {
    return support.type == shared.orderTypeEnum["support hold"] && province == support.supporting;
  }

  /**
   * Find all distinct convoy routes from `start` to `end`, assuming all convoy orders in `orders` are successful.
   * @param {shared.Order[]} orders All convoy orders are assumed to succeed.
   * @param {string} start Starting province.
   * @param {string} end Ending province.
   * @returns {number[][]} A list of routes where each route is a list of order indices for orders that must succeed for the route to succeed.
   */
  all_convoy_routes(orders, start, end) {
    /** @type {string[]} */
    let provinces = orders.filter(o => o.type == shared.orderTypeEnum.convoy && o.start == start && o.end == end).map(o => o.province);
    provinces.push(end);

    /**
     * All routes from `from` to `to` that don't pass through provinces in `ignore`.
     * @param {string} from
     * @param {string} to
     * @param {string[]} ignore
     */
    let routes = (from, ignore) => {
      if (from == end) return [[]];

      let filtered = provinces.filter(p => !ignore.includes(p));

      if (filtered.length == 0) return [];

      // Get all adjacencies
      let adj = this.get_adjacencies_ignore_coasts(from);

      // Filter them to only include unignored valid convoys.
      let filtered_adj = adj.filter(p => filtered.includes(p));

      // For each, find the routes from the adjacency to end and prepend the adjacency to each route unless the adjacency is the destination of the route.
      let adj_routes = filtered_adj.map(p => routes(p, ignore.concat(p)).map(r => p == end ? r : [p].concat(...r)));

      // Flatten the list of lists of routes to get a list of routes.
      let flattened = adj_routes.flat();

      return flattened;
    };

    /** @type {number[]} */
    let indices = provinces.map(p => orders.findIndex(o => o.province == p));

    // Return the routes, replacing province strings with corresponding order indices
    return routes(start, []).filter(r => r.length).map(route => route.map(p => indices[provinces.indexOf(p)]));
  }

  /**
   * Return whether the units at `provinceA` and `provinceB` are on the same team (i.e. unable to attack each other).
   * @param {string} provinceA ID of province for first unit.
   * @param {string} provinceB ID of province for second unit.
   * @returns {boolean} Whether the units are on the same time.
   */
  same_team(provinceA, provinceB) {
    return this.get_unit_owner_player(provinceA) == this.get_unit_owner_player(provinceB);
  }

  /**
   * Get a list of orders for which the resolution of `order` depends on the resolution of that order.
   * @param {shared.Order} order A single order, also presumably a member of `all`.
   * @param {shared.Order[]} all All orders on which `order` can depend.
   * @returns {shared.Order[]} Orders whose resolution affects the resolution of `order`.
   */
  get_dependencies(order, all) {
    return all.filter(o => this.order_depends(order, o));
  }

  /**
   * Return whether or not the resolution of `order` depends on the resolution of `dependency`.
   * @param {shared.Order} order
   * @param {shared.Order} dependency
   * @returns {boolean}
   */
  order_depends(order, dependency) {
    return order != dependency && (
      order.type == shared.orderTypeEnum.move && (
        dependency.type == shared.orderTypeEnum.move && (
          order.dest == dependency.dest // Dependency is moving into the same province as order
          || order.dest == dependency.province // Order is moving into the same province as dependency is moving out of
        )
        || dependency.type == shared.orderTypeEnum.convoy && (
          order.isconvoy && this.fleets_required(order.province, order.dest).includes(dependency.province) // Dependency is convoying order
          || order.dest == dependency.end // Dependency is convoying unit to the province order is moving to
        )
        || dependency.type == shared.orderTypeEnum["support move"] && (
          order.province == dependency.from && order.dest == dependency.supporting // Dependency is supporting order
        )
      )
      || order.type == shared.orderTypeEnum.convoy && (
        dependency.type == shared.orderTypeEnum.move && (
          order.province == dependency.dest // Dependency is attacking order, which is convoying
        )
      )
      || order.type == shared.orderTypeEnum["support move"] && (
        dependency.type == shared.orderTypeEnum.move && (
          order.province == dependency.dest && order.supporting == dependency.province // Dependency is attacking order from the square order is supporting a move to
        )
      )
    );
  }
}

exports.ServerGameData = ServerGameData;
exports.get_game_list = get_game_list;
exports.new_game = new_game;
exports.gamedata_from_id = gamedata_from_id;
exports.get_map_list = get_map_list;
exports.get_test_list = get_test_list;
exports.get_datc_list = get_datc_list;
exports.get_map_overview = get_map_overview;
exports.get_map_info = get_map_info;
exports.config = config;