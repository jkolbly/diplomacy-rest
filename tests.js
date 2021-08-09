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
  Error: "error"
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
      { key: "map", required: true },
      { key: "name", default: "Test Game" },
      { key: "userCount", type: instructionParamTypeEnum.number, default: -1 },
      { key: "countryClaiming", type: instructionParamTypeEnum.boolean, default: true },
      { key: "users", type: instructionParamTypeEnum.stringList, default: [] }
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

      if (params.countryClaiming) {
        for (let user of params.users) {
          test.gameData.claim_country(user, test.gameData.unclaimed_country_groups()[0][0]);
        }
      }
    }
  ),
  new InstructionSpec("populate", [],
    async (test, params) => {
      test.gameData.populate();
    }
  ),
  new InstructionSpec("spawn-unit", [
      { key: "country", required: true },
      { key: "province", required: true },
      { key: "fleet", type: instructionParamTypeEnum.boolean, default: false },
      { key: "coast", default: "" },
      { key: "replace", type: instructionParamTypeEnum.boolean, default: true }
    ],
    async (test, params) => {
      let province = test.gameData.get_province(params.province);
      let type = (province.water || params.fleet || params.coast) ? shared.unitTypeEnum.Fleet : shared.unitTypeEnum.Army;

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
      let province = test.gameData.get_province(params.province);

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
  )
];

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
      return JSON.parse(`"${val.replace(/^\"/g, "").replace(/((?<!\\)|(?<=\\.))(")$/g, "$1")}"`);
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
    this.logs.push({
      message: message,
      level: level
    });
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
    for await (let i of this.generator) { }
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
    try {
      await get_instruction_spec(instruction.type).execute(this, instruction.params);
    } catch (error) {
      this.log(`Error executing test instruction "${instruction.raw}": "${error.message}"`, logLevelsEnum.Error);
    }
  }

  /**
   * Return a generator that iterates through the instruction set and yields the executed instruction.
   * @returns {Generator<Promise<TestInstruction>,void,any>}
   */
  async* get_generator() {
    for (let instruction of this.instructions) {
      await this.execute(instruction);
      yield instruction;
    }
    this.log("Finished test.");
    return;
  }
}

exports.load_test = load_test;
exports.Test = Test;