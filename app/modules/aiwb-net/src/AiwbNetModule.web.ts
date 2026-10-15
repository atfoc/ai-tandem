import { unavailableAiwbNet } from "./unavailable.ts";

// There is no native network on the web: the web build reaches a server with the page's own fetch.
export default unavailableAiwbNet();
