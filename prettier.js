const fs = require("fs");
const path = require("path");
const spawn = require("child_process").spawn;

const cwd = __dirname;
const cmd = path.resolve(__dirname, "node_modules/.bin/prettier");
const exec = args => spawn(cmd, args, { cwd, stdio: "inherit", shell: true });

const args = ["--list-different", "--write"];
const files = process.argv
  .slice(2)
  .map(file => path.resolve(cwd, file))
  .filter(file => fs.existsSync(file));

if (files.length > 0) {
  console.log(args.concat(files.join(" ")));
  exec(args.concat(files.join(" ")));
}
