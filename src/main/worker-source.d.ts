/**
 * The bundled source of src/main/worker.ts as a string, produced at build
 * time (see build/workerSource.mjs). The script runner starts worker threads
 * from it, so the plugin stays a single main-process file.
 */
declare module "virtual:script-worker" {
  const source: string;
  export default source;
}
