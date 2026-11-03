declare module '*.mjs' {
 export function render(spec:unknown):{body?:string;viewBox?:number[];problems:{code:string;msg:string}[]};
}
