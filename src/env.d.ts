/// <reference types="astro/client" />

// The UI uses DOM types; Workers adds this cache to the shared CacheStorage API.
interface CacheStorage { readonly default: Cache; }
