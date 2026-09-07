const flagNames = Object.keys(PatchFlagNames).map(Number).filter((n) => n > 0 && patchFlag & n).map((n) => PatchFlagNames[n]);
