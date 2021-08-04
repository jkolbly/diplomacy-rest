const utils = require("./diplomacy-server-utils.js");
const fs = require("fs").promises;
const path = require("path");

/**
 * Enum for storing the action type for a test instruction.
 * @readonly
 * @enum {string}
 */
const instructionTypeEnum = {
  /**
   * Initialize the game.
   * 
   * Required properties:
   * - `map`
   * 
   * Optional properties:
   * - `name` Default: "test"
   * - `userCount` Default: "max"
   * - `countryClaiming` Default: false
   * - `users` Overrides `userCount` and disables `countryClaiming`. Default: ["player 1", "player 2", etc.]
   */
  start: "start",
  
  /**
   * Create starting units.
   */
  populate: "populate",

  /**
   * Claim a country for a user
   * 
   * Required properties:
   * - `country`
   * - `username`
   * 
   * Optional properties:
   * - `overrideGroups` Default: false
   */
  claim: "claim",

  /**
   * Spawn a unit.
   * 
   * Required properties:
   * - `province`
   * 
   * Optional properties:
   * - `type` "army"/"a" or "fleet"/"f". Default: "army" for land or coast province, "fleet" for water
   * - `coast` Required for summoning fleet with multiple possible coasts.
   * - `replace` Replace existing units. Default: true
   */
  spawnUnit: "spawn-unit",

  /**
   * Remove a unit.
   * 
   * Required properties:
   * - `province`
   */
  removeUnit: "remove-unit"
}

/**
 * Class with a single step in the creation of a test.
 * @typedef {Object} TestInstruction
 * @property {instructionTypeEnum} type
 */

/**
 * Load a test from a file.
 * @param {string} filename Relative to ./tests
 * @returns {Promise<Test>}
 */
async function load_test(filename) {
  let raw = (await fs.readFile(path.join("./tests", filename))).toString();

  let instructions = [];
  for (let line of raw.split("\n").filter(s => s.trim())) {
    let args = line.match(/(?:[^\s"']+|['"][^'"]*["'])+/g);
    args = args ? args : [];
    args = args.map(s => s.trim());
    let instruction = {
      type: args.shift()
    }
    for (let arg of args) {
      let split = arg.split(":");
      instruction[split.shift().trim()] = split.join(":").trim().replace(/\\"/g, '"').replace(/^\"/g, "").replace(/\"$/g, "");
    }
    instructions.push(instruction);
  }

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
     * @type {Generator<TestInstruction,void>}
     */
    this.generator = this.get_generator();
  }

  /**
   * Run the rest of the instructions.
   */
  run() {
    for (let i of this.generator) { }
  }

  /**
   * Execute the next instruction and advance the generator.
   */
  step() {
    this.generator.next();
  }

  /**
   * Execute a single instruction.
   * @param {TestInstruction} instruction 
   */
  execute(instruction) {
    
  }

  /**
   * Return a generator that iterates through the instruction set and yields the executed instruction.
   * @returns {Generator<TestInstruction,void,any>}
   */
  * get_generator() {
    for (let instruction of this.instructions) {
      this.execute(instruction);
      yield instruction;
    }
  }
}

exports.load_test = load_test;
exports.Test = Test;