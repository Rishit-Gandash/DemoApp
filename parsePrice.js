
function parsePrice(debug) {
  let i = 0;
  while (debug.slice(i, i + 6) !== "strong") {
    if (i + 6 > debug.length) {
      console.log("error: couldn't find strong in string");
      return null;
    }
    i++;
  }

  while (debug.slice(i, i + 4) !== "span") {
    if (i + 4 > debug.length) {
      console.log("error: couldn't find span in string");
      return null;
    }
    i++;
  }
  i++;

  let intPart = "";
  let decPart = "";
  let sawDecimal = false;

  while (debug.slice(i, i + 6) !== "/stro") { // see note below
    if (i + 6 > debug.length) {
      console.log("error: couldn't find closing strong in string");
      return null;
    }
    const ch = debug[i];
    if (ch === ".") {
      sawDecimal = true;
    } else if ("0123456789".includes(ch)) {
      if (sawDecimal) decPart += ch;
      else intPart += ch;
    }
    i++;
  }

  const whole = Number(intPart);
  return sawDecimal ? Number(`${whole}.${decPart}`) : whole;
}


