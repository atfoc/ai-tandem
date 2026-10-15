// The board's page is a Metro asset (AD-56): `require("….html")` gives the module id `expo-asset` turns into a file address.
declare module "*.html" { const id: number; export default id; }
