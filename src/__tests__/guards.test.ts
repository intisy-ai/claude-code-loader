import { guardDocumentation, guardNoSuppressions } from "@intisy/bayonet/testing";

guardDocumentation({ dir: new URL("..", import.meta.url) });
guardNoSuppressions({ dir: new URL("..", import.meta.url) });
