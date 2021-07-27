const express = require("express");
const cookieParser = require("cookie-parser");
const shared = require("./diplomacy-shared-utils/utils.js");
const sql = require("./bankbook-server-utils/sql-utils.js");
const utils = require("./diplomacy-server-utils.js");

const app = express();
app.use(cookieParser());

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
        authenticated(username, req, res);
      } else {
        denied(req, res);
      }
    } catch (error) {
      console.error(error);
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

app.get("/maps/list", generic_auth_func(async (username, req, res) => {
  res.send(await utils.get_map_list());
}));

app.listen(process.env.SERVER_PORT, () => { console.log(`Listening on port ${process.env.SERVER_PORT}`); });