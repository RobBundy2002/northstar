function validResourcePart(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,62}$/.test(value);
}

function validApiResource(value) {
  return typeof value === 'string' && /^[a-z0-9./-]{1,120}$/.test(value);
}

function validExecCommand(command) {
  return typeof command === 'string' && command.trim().length > 0 && command.length <= 300 && !/[;&|`$<>]/.test(command);
}

module.exports = { validResourcePart, validApiResource, validExecCommand };
