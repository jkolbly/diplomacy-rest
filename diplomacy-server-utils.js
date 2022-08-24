const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const fssync = require("fs");
const fs = fssync.promises;
const util = require("util");
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
    
    newState.retreats = {};

    this.history.push(newState);
  }

  /**
   * Mark a unit as retreating by moving from the map to the `retreats` object.
   */
  make_unit_retreat(provinceId) {
    let unit = this.get_unit(provinceId);
    if (unit) {
      let owner = this.get_unit_owner_id(provinceId);
      if (!this.state.retreats[owner]) this.state.retreats[owner] = [];
      this.state.retreats[owner].push({
        unit: unit
      });
      this.remove_unit(provinceId);
    }
  }

  /**
   * Adjudicate and apply all currently placed orders and move on to retreat writing phase.
   */
  calculate_orders() {
    if (this.phase != shared.phaseEnum["Order Writing"]) throw Error("Can only adjudicate orders during order writing phase.");

    let orders = Object.values(this.state.orders).map(nation => Object.values(nation)).reduce((arr, val) => { arr.push(...val); return arr; });
    
    /*
      REMOVE ORDERS THAT FAIL PURELY BECAUSE THEY DEPENDED ON THE EXISTENCE/LACK OF EXISTENCE OF ANOTHER ORDER
      This includes:
        - Fleets attempting to convoy units that aren't using that convoy
        - Armies attempting to convoy with no possible route
        - Units supporting moves that aren't happening
        - Support units that are being attacked from provinces other than the one they're providing support to
    */
    // /** @type {Object.<string,boolean} */
    // let results = {};
    // for (let order of orders) {
    //   if (order.type == shared.orderTypeEnum.move && order.isconvoy) {
    //     let fleetProvinces = orders.filter(o => o.type == shared.orderTypeEnum.convoy && o.start == order.province && o.end == order.dest).map(f => f.province);
    //     let pathFindStep = (province, dest, ignore=[]) => {
    //       if (province == dest) return true;
    //       for (let p of this.get_adjacencies_ignore_coasts(province)) {
    //         if (fleetProvinces.includes(p)) {
    //           return p == dest || pathFindStep(p, dest, [province, ...ignore]);
    //         }
    //       }
    //       return false;
    //     }
    //     if (!pathFindStep(order.province, order.dest)) {
    //       results[order.id] = false;
    //     }
    //   }
    // }

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

    /**
     * @param {number} orderIndex
     */
    let resolve = (orderIndex) => {
      console.log("Resolution state: " + resolutionStates[orderIndex]);
      switch (resolutionStates[orderIndex]) {
        case resolutionStateEnum.Resolved:
          return resolutions[orderIndex];
        case resolutionStateEnum.Guessing:
          if (!dep_list.includes(orderIndex)) dep_list.push(orderIndex);
          return resolutions[orderIndex];
        case resolutionStateEnum.Unresolved:
          let old_dep_size = dep_list.length;

          resolutions[orderIndex] = false;
          resolutionStates[orderIndex] = resolutionStateEnum.Guessing;

          let adj_res = adjudicate(orderIndex);

          console.log("Adjudication result: " + adj_res);

          // No dependencies
          if (old_dep_size == dep_list.length) {
            console.log("No dependencies");
            resolutionStates[orderIndex] = resolutionStateEnum.Resolved;
            resolutions[orderIndex] = adj_res;
            console.log("Returning " + adj_res);
            return adj_res;
          }

          // Dependency, but doesn't depend on itself
          if (dep_list[old_dep_size] != orderIndex) {
            dep_list.push(orderIndex);
            resolutions[orderIndex] = adj_res;
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

          let adj_res_2 = adjudicate(orderIndex);

          // Cycle only has one resolution
          if (adj_res == adj_res_2) {
            // Set all dependencies to unresolved
            for (let i = dep_list.length - 1; i >= old_dep_size; i--) {
              resolutionStates[dep_list[i]] = resolutionStateEnum.Unresolved;
            }

            resolutions[orderIndex] = adj_res;
            resolutionStates[orderIndex] = resolutionStateEnum.Resolved;
            return adj_res;
          }

          // Cycle has two or no resolutions, pass to backup rule.
          // Clean up dependencies so that dep_list.length == old_dep_size
          // Dependencies should be set to Resolved or Unresolved.
          backup_rule(old_dep_size);

          // Start over in case backup rule leaves some orders unresolved.
          return resolve(orderIndex);
      }
    };

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
            if (o.type == shared.orderTypeEnum.move && o.dest == order.province && !this.same_team(o.province, order.province) && (o.province != order.supporting || resolve(i))) {
              return false;
            }
          }
          return true;
        case shared.orderTypeEnum.move:
          // Convoys fail if any of the fleets can't convoy
          if (order.isConvoy) {
            let fail = true;
            for (let route of this.all_convoy_routes(orders, order.province, order.dest)) {
              let routeworks = true;
              for (let i of route) {
                if (!resolve(i)) {
                  fail = false;
                  routeworks = false;
                  break;
                }
              }
              if (routeworks) break;
            }
            if (fail) return false;
          }

          /**
           * @param {shared.Order} ord
           */
          let strength = ord => orders.filter((o, i) => this.order_supports(ord, o) && resolve(i)).length;

          let otherattacks = orders.filter((o, i) => i != orderIndex && o.type == shared.orderTypeEnum.move && o.dest == order.dest);
          let otherattackstrengths = otherattacks.map(o => strength(o));

          let attackstrength = strength(order);
          console.log(`Movement strength: ${attackstrength}`);
          console.log(`Other strengths: ${otherattackstrengths}`);

          for (let o of orders) {
            console.log(`${o.id} supports move? ${this.order_supports(order, o)}`);
          }

          let defender = orders.find((o, i) => o.province == order.dest && (o.type != shared.orderTypeEnum.move || !resolve(i)));
          if (defender && strength(defender) >= attackstrength) return false;

          for (let s of otherattackstrengths) {
            if (s >= attackstrength) {
              return false;
            }
          }

          return true;
        case shared.orderTypeEnum.convoy:
          for (let i = 0; i < order.length; i++) {
            let o = orders[i];
            if (o.type == shared.orderTypeEnum.move && o.dest == order.province && !this.same_team(o.province, order.province) && resolve(i)) {
              return false;
            }
          }
          return true;
      }
    };

    /**
     * @param {number} dep_start_index Index of first dependency in this cycle.
     */
    let backup_rule = (dep_start_index) => {

    }

    // Create new state object and prepare for applying adjudications.
    this.start_retreat_writing();

    console.log("\nStarting adjudication\n");

    /** Units to be dislodged. */
    let to_dislodge = [];

    /** Units that shouldn't be dislodged because they're moving. */
    let cannot_dislodge = [];

    /** Successful move orders to be executed simultaneously. */
    let successful_moves = [];

    for (let i = 0; i < orders.length; i++) {
      let order = orders[i];
      let success = resolve(i);

      if (success && order.type == shared.orderTypeEnum.move) {
        to_dislodge.push(order.dest);
        cannot_dislodge.push(order.province);

        successful_moves.push({
          unit: this.get_unit(order.province),
          dest: order.dest,
          coast: order.coast 
        });
      }

      console.log(`Does ${order.id} succeed? ${success}\n`);
    }

    for (let move of successful_moves) {
      move.unit.province = move.dest;
      move.unit.coast = move.coast;
    }

    to_dislodge = to_dislodge.filter((p) => !cannot_dislodge.includes(p));
    for (let p of to_dislodge) {
      this.make_unit_retreat(p);
    }

    console.log("Ended adjudication");
  }

  /**
   * Return whether `support` is an order supporting `order`.
   * @param {shared.Order} order Order to be supported.
   * @param {shared.Order} support Supporting order.
   * @returns {boolean} Whether `support` is a valid support order for `order`.
   */
  order_supports(order, support) {
    return (support.type == shared.orderTypeEnum["support hold"] && order.type != shared.orderTypeEnum.move && order.province == support.supporting)
      || (support.type == shared.orderTypeEnum["support move"] && order.type == shared.orderTypeEnum.move && order.dest == support.supporting && order.province == support.from);
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

    /**
     * All routes from `from` to `to` that don't pass through provinces in `ignore`.
     * @param {string} from
     * @param {string} to
     * @param {string[]} ignore
     */
    let routes = (from, ignore) => {
      if (from == end) return [[]];

      let filtered = provinces.filter(p => !ignore.includes(p));

      // Get all adjacencies.
      // Filter them to only include unignored valid convoys.
      // For each, find the routes from the adjacency to end. Prepend the adjacency to each route.
      // Flatten the list of lists of routes to return a list of routes.
      return this.get_adjacencies_ignore_coasts(from).filter(p => filtered.includes(p)).map(p => routes(p, end, ignore.concat(p)).map(r => [from].concat(r))).flat();
    };

    /** @type {number[]} */
    let indices = provinces.map(p => orders.findIndex(o => o.province == p));

    // Return the routes, replacing province strings with corresponding order indices
    return routes(start, []).map(route => route.map(p => indices[provinces.indexOf(p)]));
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
exports.get_map_overview = get_map_overview;
exports.get_map_info = get_map_info;
exports.config = config;