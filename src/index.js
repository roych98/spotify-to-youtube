const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const bodyParser = require('body-parser');
const request = require('request-promise');
// const YouTubeSearchApi = require('youtube-search-api');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const OAuth2 = google.auth.OAuth2;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://s2y.royc.io/oauthcb';

const oauth2Client = new OAuth2(
	GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET,
	REDIRECT_URI
);

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET

const app = express();
const PORT = 80;

app.use(bodyParser.urlencoded({ extended: true }));

const getSpotifyAccessToken = async () => {
	const authOptions = {
		url: 'https://accounts.spotify.com/api/token',
		headers: {
			'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'),
		},
		form: {
			grant_type: 'client_credentials',
		},
		json: true,
	};

	try {
		const response = await request.post(authOptions);
		return response.access_token;
	} catch (error) {
		console.error('Failed to get access token:', error);
		return null;
	}
};

const scrapeSpotify = async ({ spotifyLink }) => {
	const playlistId = spotifyLink.split('playlist/')[1].split('?')[0];

	const accessToken = await getSpotifyAccessToken();

	if (!accessToken) {
		res.send('Failed to get access token');
		return;
	}

	const options = {
		url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
		headers: {
			'Authorization': 'Bearer ' + accessToken,
		},
		json: true,
	};

	try {
		const data = await request.get(options);
		const tracks = data.items.map(item => {
			return {
				artist: item.track.artists.map(artist => artist.name).join(', '),
				song: item.track.name,
			};
		});

		console.log(tracks);
		return tracks;
	} catch (error) {
		console.error('Error fetching playlist tracks:', error);
	}
}

const authUrl = oauth2Client.generateAuthUrl({
	access_type: 'offline',
	scope: ['https://www.googleapis.com/auth/youtube'],
});

app.get('/auth', (req, res) => {
	res.redirect(authUrl);
});

app.get('/oauthcb', async (req, res) => {
	const { code } = req.query;

	try {
		const { tokens } = await oauth2Client.getToken(code);
		oauth2Client.setCredentials(tokens);

		res.sendFile(path.join(__dirname, 'form.html'));
	} catch (error) {
		console.error('Error during OAuth callback:', error);
		res.send('Error during OAuth callback');
	}
});

app.post('/create-playlist', async (req, res) => {
	const { spotifyLink, playlistName, playlistDescription } = req.body;

	const playlistData = await scrapeSpotify({ spotifyLink });


	try {
		const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

		const response = await youtube.playlists.insert({
			part: 'snippet,status',
			resource: {
				snippet: {
					title: playlistName,
					description: playlistDescription
				},
				status: {
					privacyStatus: 'public'
				}
			}
		});

		const playlistId = response.data.id;

		const videoIds = [];
		// This method consumes too many of Youtube API v3 credit quota, so I decided to use a lib like youtube-search-api to scrape the data straight from youtube. Less accurate results.
		for (const track of playlistData) {
			const query = `${track.artist} ${track.song}`;
			const options = {
				url: 'https://www.googleapis.com/youtube/v3/search',
				qs: {
					part: 'snippet',
					q: query,
					type: 'video',
					key: process.env.YOUTUBE_API_KEY,
					maxResults: 1,
				},
				json: true,
			};

			try {
				const response = await request.get(options);
				if (response.items && response.items.length > 0) {
					const videoId = response.items[0].id.videoId;
					videoIds.push(videoId);
				}
			} catch (error) {
				console.error(`Error fetching video ID for ${query}:`, error);
			}
		}

		// This method doesn't consume any YouTube API v3 credits, but is less accurate...to say the least...
		/*for (const track of playlistData) {
			try {
				const results = await YouTubeSearchApi.GetListByKeyword(`${track.arist} ${track.song}`, false, 1);

				console.log(results);
				console.log(results.items);

				if (results.items.length < 0) continue;
				const videoId = results.items[0].id;

				videoIds.push(videoId);
			} catch (error) {
				console.error(error);
			}
		};*/

		for (const videoId of videoIds) {
			try {
				const response = await youtube.playlistItems.insert({
					part: 'snippet',
					resource: {
						snippet: {
							playlistId: playlistId,
							resourceId: {
								kind: 'youtube#video',
								videoId: videoId,
							},
						},
					},
				});
				console.log(`Added video ${videoId} to playlist: ${response.data}`);
			} catch (error) {
				console.error(`Failed to add video ${videoId}:`, error);
			}
		}

		console.log('Playlist created:', response.data);
		res.send(`Playlist created: ${response.data.id}`);
	} catch (error) {
		console.error('Error creating playlist:', error);
		res.send('Error creating playlist');
	}
});

app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
});