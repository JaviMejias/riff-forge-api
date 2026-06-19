declare module 'lyrics-finder' {
  function lyricsFinder(artist: string, title: string): Promise<string>;
  export = lyricsFinder;
}
