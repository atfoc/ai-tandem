Add this to `package.json` and run `npm install`:

```json
{
  "scripts": {
    "test": "node --test",
    "build": "tsc -p ."
  }
}
```

Then the entry point:

```ts
export function main(argv: string[]): number {
  console.log("hello, world.");
  return 0;
}
```

    indented code is code too
    and so is this line

That is all it takes.
