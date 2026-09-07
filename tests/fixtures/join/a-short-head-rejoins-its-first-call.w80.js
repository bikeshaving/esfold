const text = fs
  .readFileSync(new URL(`./templates/${name}.js`, import.meta.url), "utf-8")
  .replace(/\r\n/g, "\n");
