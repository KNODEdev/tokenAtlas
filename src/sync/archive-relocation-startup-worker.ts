import {verifyStartupArchiveRelocation} from "./archive-relocation-startup";

if(import.meta.main)console.log(JSON.stringify(await verifyStartupArchiveRelocation(JSON.parse(process.argv[2]??"null"))));
