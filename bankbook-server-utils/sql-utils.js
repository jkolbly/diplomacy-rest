const mysql = require("mysql");
const util = require("util");

/** @type {mysql.Pool} */
var pool;
var pools = {};

/** @type {Promise} */
var query;
var queries = {};

/** @type {string} */
var mainDatabase;

/**
 * Create a mysql connection pool and use this pool for future queries.
 * Sets the `pool` and `query` exported values.
 * @param {string} host Hostname of SQL server 
 * @returns {Promise} A promise wrapper for the pool query function
 */
function mysql_connect(host, user, password, database, main=true) {
  pools[database] = mysql.createPool({
    connectionLimit: 10,
    host: host,
    user: user,
    password: password,
    database: database
  });
  queries[database] = util.promisify(pools[database].query).bind(pools[database]);

  if (main) {
    pool = pools[database];
    query = queries[database];
    mainDatabase = database;

    exports.pool = pool;
    exports.query = query;
  }

  exports.pools = pools;

  return pools[database];
}

/**
 * @param {express.Request} req Request object with auth_token cookie.
 * @param {string} app String ID of app to check permissions or empty for no permission checking.
 * @returns {Promise<[boolean, string?]>} Whether the user is authenticated and the username or reason for not being authenticated.
 */
async function authenticate(req, app="") {
  if (req.cookies.auth_token) {
    const rows = await query("SELECT username FROM tokens WHERE token=?", [req.cookies.auth_token]);
    if (rows.length > 0) {
      let username = rows[0].username;
      if (app) {
        if (await user_app_permission(username, app)) {
          return [true, username];
        } else {
          return [false, `User ${username} doesn't have permission to use app ${app}.`]
        }
      } else {
        return [true, username];
      }
    }
    return [false, `No matching auth token found on server for ${req.cookies.auth_token}.`];
  }
  return [false, "No auth_token cookie found."];
}

/**
 * Get whether or not a user has permission to use an app
 * @param {string} username String username of user
 * @param {string} app String ID of app
 * @returns {Promise<boolean>}
 */
async function user_app_permission(username, app) {
  if (await column_exists("users", app)) {
    let rows = await query(`SELECT ${pool.escapeId(app)} FROM users WHERE username=?`, [username]);
    if (rows.length > 0) {
      return rows[0][app] == true;
    } else {
      throw Error(`No user found with username ${username}`);
    }
  }
  return false;
}

/**
 * Get whether or not a column exists on a table. Sanitizes both inputs for safety.
 * @param {string} table ID of table
 * @param {string} column String to match columns
 * @returns {Promise<boolean>}
 */
async function column_exists(table, column) {
  return (await query(`SHOW COLUMNS FROM ?? LIKE ?`, [table, column])).length > 0;
}

/**
 * @typedef {Object} UserData
 * @property {string} username
 * @property {string} firstname
 * @property {string} lastname
 * @property {string} type
 * @property {string} email
 */

/** @type {Object.<string, UserData>} */
const user_data_cache = {};

/**
 * @param {string} username
 * @returns {Promise<UserData>}
 */
async function user_data(username) {
  if (user_data_cache[username]) {
    return user_data_cache[username];
  } else {
    let rows = await query("SELECT username, first_name AS firstname, last_name AS lastname, type, email FROM users WHERE username=?", [username]);
    if (rows.length > 0) {
      return user_data_cache[username] = rows[0];
    }
    throw Error(`No user found with username ${username}`);
  }
}

exports.mysql_connect = mysql_connect;
exports.authenticate = authenticate;
exports.user_app_permission = user_app_permission;
exports.user_data = user_data;