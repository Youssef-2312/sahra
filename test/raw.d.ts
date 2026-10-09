// Vite's "?raw" imports (a file's text), used to check page content against code.
declare module "*?raw" {
  const text: string;
  export default text;
}
