const { Client } = require("genius-lyrics");
const client = new Client(); // Scrapes if no key is provided

async function test() {
  const searches = await client.songs.search("Queen Bohemian Rhapsody");
  const firstSong = searches[0];
  console.log("Found:", firstSong.title);
  const lyrics = await firstSong.lyrics();
  console.log(lyrics.substring(0, 100));
}
test().catch(console.error);
