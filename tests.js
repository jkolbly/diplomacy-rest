const utils = require("./diplomacy-server-utils.js");
const shared = require("./diplomacy-shared-utils/utils.js");
const fs = require("fs").promises;
const path = require("path");

/**
 * Enum to store the type of parameter for a single instruction parameter.
 * @readonly
 * @enum {string}
 */
const instructionParamTypeEnum = {
  string: "string",
  number: "number",
  boolean: "boolean",
  /** Comma-separated list of strings */
  stringList: "list-string"
}

/**
 * Enum to store the log levels for messages in a test log.
 * @readonly
 * @enum {string}
 */
const logLevelsEnum = {
  /** Messages that aren't normally visible but provide extra information for debugging. */
  Debug: "debug",
  /** Messages that are normally visible but aren't errors. */
  Log: "log",
  /** Messages that are errors, including failed assertions. */
  Error: "error",
  /** Messages that are just the string representation of an instruction */
  Instruction: "instruction"
}

/**
 * Class with a single step in the creation of a test.
 * @typedef {Object} TestInstruction
 * @property {string} type
 * @property {Object.<string,any>} params
 * @property {string} raw
 */

/**
 * Data required to define a single instruction set parameter.
 * @typedef {object} InstructionParamSpec
 * @property {string} key Name of this parameter
 * @property {instructionParamTypeEnum} [type] Default: string
 * @property {any} [default] Default value for parameter
 * @property {boolean} [required] Default: false
 */

const unitTypeDictionary = {
  army: [ "army", "a" ],
  fleet: [ "fleet", "f" ]
}

/**
 * Parse the English word version of a unit type ("army", "a", "fleet", or "f").
 * @param {string} english 
 * @returns {shared.unitTypeEnum}
 */
function type_from_english(english) {
  let lower = english.toLowerCase();
  if (unitTypeDictionary.army.includes(lower)) return shared.unitTypeEnum.Army;
  if (unitTypeDictionary.fleet.includes(lower)) return shared.unitTypeEnum.Fleet;
  throw Error(`Unknown unit type ${english}`);
}

/**
 * Get the English word version of a unit type.
 * @param {shared.unitTypeEnum} type 
 * @returns {string}
 */
function english_from_type(type) {
  if (type == shared.unitTypeEnum.Army) return unitTypeDictionary.army[0];
  if (type == shared.unitTypeEnum.Fleet) return unitTypeDictionary.fleet[0];
  throw Error(`Unknown unit type ${type}`);
}

/**
 * Class with the specifications for an instruction type (name, parameters, etc.) and methods to execute the instruction.
 */
class InstructionSpec {
  /**
   * @param {string|string[]} keyword Keyword or list of keyword synonyms
   * @param {InstructionParamSpec[]} params
   * @param {(test:Test,params:Object.<string,any>)=>(void|Promise)} execute
   */
  constructor(keyword, params, execute) {
    if (typeof keyword == "string") {
      /**
       * All keywords that can refer to this instruction.
       * @type {string[]}
       */
      this.keywords = [keyword];
    } else {
      this.keywords = keyword;
    }
    this.keywords = this.keywords.map(s => s.toLowerCase());

    /**
     * The parameters for this instruction.
     * @type {InstructionParamSpec[]}
     */
    this.params = params;
    for (let param of this.params) {
      if (!param.type) param.type = instructionParamTypeEnum.string;
      if (!param.required) param.required = false;
    }

    /**
     * The execute function for this instruction
     * @type {(test:Test,params:Object.<string,any>)=>(void|Promise)}
     */
    this.execute = execute;
  }

  /**
   * Return whether the keywords for this instruction include `word`.
   * @param {string} word
   * @returns {boolean} 
   */
  matches(word) {
    return this.keywords.includes(word.toLowerCase());
  }

  /**
   * Get the param spec corresponding to `key`
   * @param {string} key
   * @returns {InstructionParamSpec} 
   */
  get_param_spec(key) {
    return this.params.find(p => p.key == key);
  }
}

const instructionSpecs = [
  new InstructionSpec(["start", "init"], [
      { key: "map", default: "europe/europe.dipmap" },
      { key: "name", default: "Test Game" },
      { key: "userCount", type: instructionParamTypeEnum.number, default: -1 },
      { key: "countryClaiming", type: instructionParamTypeEnum.boolean, default: true },
      { key: "users", type: instructionParamTypeEnum.stringList, default: [] },
      { key: "date", type: instructionParamTypeEnum.number, default: -1 },
      { key: "season", type: instructionParamTypeEnum.string, default: "" }
    ],
    async (test, params) => {
      if (params.users.length == 0) {
        if (params.userCount < 1) {
          let possibleCounts = Object.keys((await utils.get_map_info(params.map)).playerConfigurations).map(n => Number(n));
          params.userCount = params.userCount == 0 ? Math.min(...possibleCounts) : Math.max(...possibleCounts);
        }
        for (let i = 1; i <= params.userCount; i++) {
          params.users.push(`Player ${i}`);
        }
      } else {
        params.countryClaiming = false;
        params.userCount = params.users.length;
      }

      test.gameData = await utils.new_game(params.users[0], params.name, params.map, params.users, false, false);

      if (params.date != -1) test.gameData.state.date = params.date;
      if (params.season) switch (params.season.toLowerCase()) {
        case "spring":
          test.gameData.state.season = shared.seasonEnum.Spring;
          break;
        case "fall":
          test.gameData.state.season = shared.seasonEnum.Fall;
          break;
        default:
          throw Error(`Unknown season ${params.season}`);
      }

      if (params.countryClaiming) {
        for (let user of params.users) {
          test.gameData.claim_country(user, test.gameData.unclaimed_country_groups()[0][0]);
        }
      }
    }
  ),
  new InstructionSpec("populate", [],
    async (test, _params) => {
      test.gameData.populate();
    }
  ),
  new InstructionSpec("claim-country", [
      { key: "user", required: true },
      { key: "country", required: true }
    ],
    async (test, params) => {
      if (!test.gameData.users.includes(params.user)) throw Error(`Unknown player ${params.user}`);
      test.gameData.claim_country(params.user, params.country);
    }
  ),
  new InstructionSpec("spawn-unit", [
      { key: "country", required: true },
      { key: "province", required: true },
      { key: "fleet", type: instructionParamTypeEnum.boolean, default: false },
      { key: "type", default: "" },
      { key: "coast", default: "" },
      { key: "replace", type: instructionParamTypeEnum.boolean, default: true }
    ],
    async (test, params) => {
      let province = test.gameData.get_province_or_err(params.province);

      let type = null;
      if (params.type) type = type_from_english(params.type);
      if (type == shared.unitTypeEnum.Army && params.fleet) throw Error(`Invalid test instruction. A unit cannot be a fleet and an army at the same time.`);
      if (type == shared.unitTypeEnum.Army && params.coast) throw Error(`Invalid test instruction. An army cannot be spawned on a coast.`);
      if (type == null) type = (params.coast || province.water) ? shared.unitTypeEnum.Fleet : shared.unitTypeEnum.Army;

      test.gameData.spawn_unit(params.country, params.province, type, params.coast, params.replace);
    }
  ),
  new InstructionSpec("remove-unit", [
      { key: "province", required: true }
    ],
    async (test, params) => {
      test.gameData.remove_unit(params.province);
    }
  ),
  new InstructionSpec("assert-unit", [
      { key: "province", required: true },
      { key: "type", default: "" },
      { key: "country", default: "" },
      { key: "coast", default: "" }
    ],
    async (test, params) => {
      let unit = test.gameData.get_unit(params.province);
      if (!unit) throw Error(`Assert failed: no unit at ${params.province}`);

      if (params.type) {
        let type = type_from_english(params.type);
        if (unit.type != type) throw Error(`Assert failed: unit at ${params.province} is ${english_from_type(unit.type)} not ${english_from_type(type)}`);
      }

      if (params.country) {
        let owner = test.gameData.get_unit_owner_id(params.province);
        if (owner != params.country) throw Error(`Assert failed: unit at ${params.province} belongs to ${owner} not ${params.country}`);
      }

      if (params.coast && unit.coast != params.coast) throw Error(`Assert failed: no unit at ${params.province} on coast ${params.coast}`);
    }
  ),
  new InstructionSpec("assert-not-unit", [
      { key: "province", required: true },
      { key: "type", default: "" },
      { key: "country", default: "" },
      { key: "coast", default: "" }
    ],
    async (test, params) => {
      let unit = test.gameData.get_unit(params.province);

      if (!unit) return;
      if (params.type && unit.type != type_from_english(params.type)) return;
      if (params.country && params.country != test.gameData.get_unit_owner_id(params.province)) return;
      if (params.coast && params.coast != unit.coast) return;

      throw Error(`Assert failed: found ${params.type ? params.type : "unit"} ${params.country ? `belonging to ${params.country} ` : ""}at ${params.province}${params.coast ? " " + params.coast : ""}`);
    }
  ),
  new InstructionSpec("order-hold", [
      { key: "country", required: true },
      { key: "unit", required: true },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      conditional_expect_error(
        () => test.gameData.submit_order(test.gameData.country_owner(params.country), new shared.HoldOrder(params.unit)),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("order-move", [
      { key: "country", required: true },
      { key: "unit", required: true },
      { key: "dest", required: true },
      { key: "coast", default: "" },
      { key: "convoy", type: instructionParamTypeEnum.boolean, default: false },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      let province = test.gameData.get_province(params.dest);
      if (province.coasts.length == 1 && test.gameData.get_unit(params.unit).type == shared.unitTypeEnum.Fleet) params.coast = province.coasts[0].id;
      conditional_expect_error(
        () => test.gameData.submit_order(test.gameData.country_owner(params.country), new shared.MoveOrder(params.unit, params.dest, params.coast, params.convoy)),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("order-convoy", [
      { key: "country", required: true },
      { key: "unit", required: true },
      { key: "from", required: true },
      { key: "to", required: true },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      conditional_expect_error(
        () => test.gameData.submit_order(test.gameData.country_owner(params.country), new shared.ConvoyOrder(params.unit, params.from, params.to)),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("order-support", [
      { key: "country", required: true },
      { key: "unit", required: true },
      { key: "supporting", required: true },
      { key: "from", default: "" },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      conditional_expect_error(
        () => test.gameData.submit_order(test.gameData.country_owner(params.country),
            params.from
              ? new shared.SupportMoveOrder(params.unit, params.supporting, params.from)
              : new shared.SupportHoldOrder(params.unit, params.supporting)),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("order-retreat", [
      { key: "country", required: true },
      { key: "unit", required: true },
      { key: "dest", required: true },
      { key: "coast", default: "" },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      let province = test.gameData.get_province(params.dest);
      if (
        province.coasts.length == 1
        && test.gameData.history[test.gameData.history.length - 2]
        && test.gameData.history[test.gameData.history.length - 2].dislodgements
        && test.gameData.history[test.gameData.history.length - 2].dislodgements[params.unit]
        && test.gameData.history[test.gameData.history.length - 2].dislodgements[params.unit].unit.type == shared.unitTypeEnum.Fleet
        ) params.coast = province.coasts[0].id;
      conditional_expect_error(
        () => test.gameData.submit_order(test.gameData.country_owner(params.country), new shared.RetreatOrder(params.unit, params.dest, params.coast)),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("order-build", [
      { key: "country", required: true },
      { key: "province", required: true },
      { key: "coast", default: "" },
      { key: "fleet", type: instructionParamTypeEnum.boolean, default: false },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      conditional_expect_error(
        () => test.gameData.submit_order(
          test.gameData.country_owner(params.country),
          new shared.BuildOrder(
            params.country,
            params.province,
            params.fleet
              ? shared.unitTypeEnum.Fleet
              : shared.unitTypeEnum.Army, params.coast
          )
        ),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("order-disband", [
      { key: "country", required: true },
      { key: "unit", required: true },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      conditional_expect_error(
        () => test.gameData.submit_order(test.gameData.country_owner(params.country), new shared.DisbandOrder(params.country, params.unit)),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("order-pass", [
      { key: "country", required: true },
      { key: "shouldfail", type: instructionParamTypeEnum.boolean, default: false }
    ],
    async (test, params) => {
      conditional_expect_error(
        () => test.gameData.submit_order(test.gameData.country_owner(params.country), new shared.PassOrder(params.country)),
        params.shouldfail
      );
    }
  ),
  new InstructionSpec("adjudicate", [],
    async (test, _params) => {
      if (test.gameData.phase == shared.phaseEnum["Order Writing"]) test.gameData.calculate_orders();
    }
  ),
  new InstructionSpec("process-retreats", [],
    async (test, _params) => {
      if (test.gameData.phase == shared.phaseEnum.Retreating) test.gameData.calculate_retreats();
    }
  ),
  new InstructionSpec("process-adjustments", [],
    async (test, _params) => {
      if (test.gameData.phase == shared.phaseEnum["Creating/Disbanding"]) test.gameData.calculate_adjustments();
    }
  ),
  new InstructionSpec("todo", [],
    async (_test, _params) => {
      throw Error("Encountered \"todo\" instruction");
    }
  )
];

function conditional_expect_error(tocall, expect_error) {
  try {
    tocall();
  } catch (error) {
    if (!expect_error) throw error;
    return;
  }
  if (expect_error) throw Error("Expected error but none was thrown.");
}

/**
 * Get the instruction spec with a given keyword.
 * @param {string} keyword
 * @returns {InstructionSpec} 
 */
function get_instruction_spec(keyword) {
  return instructionSpecs.find(i => i.matches(keyword));
}

/**
 * Parse a single parameter value based on its type
 * @param {string} val 
 * @param {instructionParamTypeEnum} type 
 * @returns {any}
 */
function parse_raw_val(val, type) {
  switch (type) {
    case instructionParamTypeEnum.string:
      return JSON.parse(`"${val.replace(/^"/g, "").replace(/((?<!\\)|(?<=\\.))(")$/g, "$1")}"`);
    case instructionParamTypeEnum.number:
      return Number(val);
    case instructionParamTypeEnum.boolean:
      return val.toLowerCase() == "true";
    case instructionParamTypeEnum.stringList:
      return val.match(/(?:(?:[^,"\\]|\\.)+|"(?:[^"\\]|\\.)*")+/g).map(s => parse_raw_val(s, instructionParamTypeEnum.string));
    default:
      throw Error(`Unknown instruction parameter type ${type}`)
  }
}

/**
 * Create an instruction from text.
 * @param {string} line 
 * @returns {TestInstruction}
 */
function parse_instruction(line) {
  let args = line.match(/(?:(?:[^\s"\\]|\\.)+|"(?:[^"\\]|\\.)*")+/g).map(s => s.trim());
  let instruction = { type: args.shift(), params: {} }

  let instructionSpec = get_instruction_spec(instruction.type);
  if (!instructionSpec) throw Error(`Unknown instruction ${instruction.type}`);

  for (let arg of args) {
    let split = arg.split(":");
    let key = split.shift().trim();
    instruction.params[key] = split.join(":").trim();
  }

  for (let param of instructionSpec.params) {
    if (instruction.params[param.key]) {
      instruction.params[param.key] = parse_raw_val(instruction.params[param.key], param.type);
    } else {
      if (param.required) throw Error(`Parameter '${param.key}' (${param.type}) is required for instruction ${instruction.type}`);
      instruction.params[param.key] = JSON.parse(JSON.stringify(param.default));
    }
  }

  instruction.raw = line;

  return instruction;
}

/**
 * Load a test from a file.
 * @param {string} filename Relative to ./tests
 * @returns {Promise<Test>}
 */
async function load_test(filename) {
  let raw = (await fs.readFile(path.join("./tests", filename))).toString();

  let instructions = raw.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#")).map(l => parse_instruction(l));

  return new Test(instructions);
}

/**
 * Class representing a testing scenario.
 */
class Test {
  /**
   * @param {TestInstruction[]} instructions Test instructions to be run.
   */
  constructor(instructions) {
    /**
     * List of test instructions to be run.
     * @type {TestInstruction[]}
     */
    this.instructions = instructions;

    /**
     * @type {Generator<Promise<TestInstruction>,void>}
     */
    this.generator = this.get_generator();

    /**
     * @type {{message:string,level:logLevelsEnum}[]}
     */
    this.logs = [];

    /**
     * Logs from the most recent test instruction
     * @type {{message:string,level:logLevelsEnum}[]}
     */
    this.lastLogs = [];

    /* For documentation only. These properties may or may not be undefined at runtime. */
    /**
     * @type {utils.ServerGameData}
     */
    this.gameData;
  }

  /**
   * Log a message about this test.
   * @param {string} message
   * @param {logLevelsEnum} level
   */
  log(message, level=logLevelsEnum.Log) {
    let msg = {
      message: message,
      level: level
    };
    this.logs.push(msg);
    this.lastLogs.push(msg);
  }

  /**
   * Log a message at the "debug" level.
   * @param {string} message 
   */
  debug(message) {
    this.log(message, logLevelsEnum.Debug);
  }

  /**
   * Log a message at the "error" level.
   * @param {string} message 
   */
  error(message) {
    this.log(message, logLevelsEnum.Error);
  }

  /**
   * Run the rest of the instructions.
   */
  async run() {
    for await (let _ of this.generator) { /* empty */ }
  }

  /**
   * Execute the next instruction and advance the generator.
   */
  async step() {
    await this.generator.next();
  }

  /**
   * Execute a single instruction.
   * @param {TestInstruction} instruction 
   */
  async execute(instruction) {
    this.lastLogs = [];
    try {
      await get_instruction_spec(instruction.type).execute(this, instruction.params);
    } catch (error) {
      this.log(error.message, logLevelsEnum.Error);
      console.error(error);
    }
  }

  /**
   * Return a generator that iterates through the instruction set and yields the executed instruction.
   * @returns {Generator<Promise<TestInstruction>,void,any>}
   */
  async* get_generator() {
    for (let instruction of this.instructions) {
      this.log(instruction.raw, logLevelsEnum.Instruction);
      await this.execute(instruction);
      yield instruction;
    }
    this.log("Finished test.");
    return;
  }
}

exports.load_test = load_test;
exports.Test = Test;