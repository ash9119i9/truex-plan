import type {NextConfig} from 'next';
const config:NextConfig={output:'standalone',outputFileTracingRoot:require('node:path').join(__dirname,'..'),turbopack:{root:require('node:path').join(__dirname,'..')}};
export default config;
