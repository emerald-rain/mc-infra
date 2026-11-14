// Text imports, see [[rules]] in wrangler.toml
declare module "*.yaml" {
    const text: string;
    export default text;
}
declare module "*.html" {
    const text: string;
    export default text;
}
