// Script Node.js para procesar múltiples archivos NDJSON de partidas de LoL.
// 'actualTeamName' se deriva directamente del prefijo del playerName.
// Maneja tags de equipo alfanuméricos.

const fs = require('fs');
const path = require('path');

const EVENT = "ward_placed";
const MODE = "EVENT"; // "EVENT" o "TIME"
// --- CONFIGURACIÓN ---
const inputFolder = path.join(__dirname, 'partidas_jsonl'); 
const outputFile = path.join(__dirname, MODE === "TIME" ? 'heatmap_tracking_data.json' : 'heatmap_wards_data.json'); // Archivo de salida para la app web

const GAMES_TIMES = 500000 // 8:30

const GAME_MAP_MIN_X = 0; const GAME_MAP_MAX_X = 16000;
const GAME_MAP_MIN_Y = 0; const GAME_MAP_MAX_Y = 16000; // 'z' en los datos del juego
const IMAGE_WIDTH_PX = 512; const IMAGE_HEIGHT_PX = 512;
const HEATMAP_POINT_VALUE = 20;
const ERROR_MARGIN = 10000; // 1 second margin for game time matching

/**
 * Transforma las coordenadas del juego a coordenadas de píxeles para la imagen del mapa.
 * @param {number} gameX Coordenada X del juego.
 * @param {number} gameZ_as_Y Coordenada Z del juego (usada como Y).
 * @returns {{x: number, y: number}} Coordenadas en píxeles.
 */
function transformCoordinates(gameX, gameZ_as_Y) {
    let normalizedX = (gameX - GAME_MAP_MIN_X) / (GAME_MAP_MAX_X - GAME_MAP_MIN_X);
    let normalizedY = (gameZ_as_Y - GAME_MAP_MIN_Y) / (GAME_MAP_MAX_Y - GAME_MAP_MIN_Y);
    let pixelX = normalizedX * IMAGE_WIDTH_PX;
    let pixelY = (1 - normalizedY) * IMAGE_HEIGHT_PX; // Invertir Y porque el origen (0,0) de la imagen es arriba a la izquierda
    return { x: Math.round(pixelX), y: Math.round(pixelY) };
}

/**
 * Intenta extraer un prefijo de equipo (tag) del nombre de un jugador.
 * @param {string} playerName El nombre del jugador.
 * @returns {string|null} El tag del equipo (ej. "FVN", "7D") o null si no se encuentra.
 */
function getTeamPrefixFromPlayerName(playerName) {
    if (typeof playerName !== 'string') return null;
    // Busca un prefijo de 2 a 4 caracteres ALFANUMÉRICOS (mayúsculas o números) al inicio del nombre, seguido de un espacio.
    const match = playerName.match(/^([A-Z0-9]{2,4})\s/); 
    if (match && match[1]) {
        return match[1]; 
    }
    return null; 
}

/**
 * Extrae el ID de la serie y el número del juego del nombre del archivo.
 * @param {string} fileName Nombre del archivo.
 * @returns {{serieId: string, gameNumberInSerie: number}}
 */
function extractSeriesInfo(fileName) {
    // Intenta con el formato events_SERIEID_GAMENUMBER_riot.jsonl
    let match = fileName.match(/events_(\d+)_(\d+)_riot\.jsonl/);
    if (match && match[1] && match[2]) {
        return { serieId: match[1], gameNumberInSerie: parseInt(match[2], 10) };
    }
    // Intenta con el formato SERIEID_GAMENUMBER.jsonl (si no tiene "events_" o "_riot")
    match = fileName.match(/(\d+)_(\d+)\.jsonl/);
    if (match && match[1] && match[2]) {
        return { serieId: match[1], gameNumberInSerie: parseInt(match[2], 10) };
    }
    console.warn(`  No se pudo extraer serieId/gameNumber del nombre de archivo: ${fileName}. Usando fallback.`);
    return { serieId: "serie_" + fileName.replace(/\.jsonl$/, ''), gameNumberInSerie: 0 }; // Fallback si no coincide
}

/**
 * Función principal para procesar todos los archivos de datos del juego.
 */
async function processAllGameData() {
    let allFiles;
    try {
        allFiles = fs.readdirSync(inputFolder);
    } catch (error) {
        console.error(`Error al leer la carpeta de entrada "${inputFolder}": ${error.message}`);
        console.log("Asegúrate de que la carpeta 'partidas_jsonl' exista en el mismo directorio que este script y contenga tus archivos .jsonl");
        process.exit(1);
    }

    const jsonlFiles = allFiles.filter(file => file.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) {
        console.log(`No se encontraron archivos .jsonl en la carpeta: ${inputFolder}`);
        process.exit(0);
    }
    console.log(`Procesando ${jsonlFiles.length} archivos .jsonl.`);

    let allEvents = []; 
    let totalEventsProcessed = 0;

    for (const fileName of jsonlFiles) {
        const filePath = path.join(inputFolder, fileName);
        console.log(`\nProcesando: ${fileName}`);
        const seriesInfo = extractSeriesInfo(fileName);

        let fileContent;
        try {
            fileContent = fs.readFileSync(filePath, 'utf-8');
        } catch (error) {
            console.error(`  Error al leer "${fileName}": ${error.message}`);
            continue; // Saltar al siguiente archivo si este no se puede leer
        }

        const gameEvents = fileContent.trim().split('\n').map(line => {
            try { return JSON.parse(line); } 
            catch { /* console.warn(`  Línea inválida en ${fileName}, saltando.`); */ return null; }
        }).filter(e => e !== null); // Filtrar líneas que no se pudieron parsear

        // Mapa para almacenar la información del participante (teamIdInGame y playerName) para la partida actual
        let participantDataMap = {}; 

        // Recopilar información de los participantes de los eventos relevantes (champ_select, game_info, stats_update)
        gameEvents.forEach(event => {
            const processParticipant = (p, defaultTeamID) => {
                if (p.participantID === undefined) return;
                const teamIdInGame = p.teamID || defaultTeamID; // teamID del lado (100 o 200)
                if (!teamIdInGame) return; // Necesitamos un teamIdInGame

                // Intentar obtener el nombre del jugador de varias fuentes posibles
                let playerName = p.summonerName || 
                                 (p.riotId ? p.riotId.displayName : null) || 
                                 p.displayName || 
                                 p.playerName || 
                                 `Jugador_${p.participantID}`; // Fallback si no hay nombre
                
                // Guar dar o actualizar la información del participante
                // Se prioriza la información de eventos más tempranos (champ_select, game_info) si ya existe un nombre "real"
                if (!participantDataMap[p.participantID] || 
                    (participantDataMap[p.participantID].playerName && participantDataMap[p.participantID].playerName.startsWith("Jugador_"))) {
                    participantDataMap[p.participantID] = { 
                        teamIdInGame: teamIdInGame, 
                        playerName: playerName
                    };
                }
            };

            if (event.rfc461Schema === "game_info" && event.participants) {
                event.participants.forEach(p => processParticipant(p));
            } else if (event.rfc461Schema === "champ_select") {
                if (event.teamOne) event.teamOne.forEach(p => processParticipant(p, 100));
                if (event.teamTwo) event.teamTwo.forEach(p => processParticipant(p, 200));
            } else if (event.rfc461Schema === "stats_update" && event.participants) {
                 event.participants.forEach(p => processParticipant(p)); // Actualizará si el nombre es mejor o no existe
            }
        });
        // console.log(`  Mapa de participantes para ${fileName}:`, participantDataMap);
        if (MODE === "EVENT") {
        let eventsInThisFile = 0;
        gameEvents.forEach(event => {
            if (event.rfc461Schema === EVENT) {
                const placerID = event.placer || event.participant;
                const playerData = participantDataMap[placerID]; // Contiene teamIdInGame y playerName
                const gameTime = event.gameTime;

                if (playerData && playerData.playerName && event.position && gameTime !== undefined) {
                    const actualTeamName = getTeamPrefixFromPlayerName(playerData.playerName); 
                    
                    // Solo procesar si se pudo inferir un tag de equipo del jugador
                    if (actualTeamName) { 
                        const { x: pixelX, y: pixelY } = transformCoordinates(event.position.x, event.position.z);
                        allEvents.push({ 
                            x: pixelX, y: pixelY, value: HEATMAP_POINT_VALUE,
                            gameTime: gameTime,
                            playerName: playerData.playerName,
                            teamIdInGame: playerData.teamIdInGame, 
                            actualTeamName: actualTeamName, // Nombre real del equipo del JUGADOR
                            serieId: seriesInfo.serieId,
                            gameNumberInSerie: seriesInfo.gameNumberInSerie,
                            gameFileName: fileName,
                            value : 100
                        });
                        eventsInThisFile++;
                    } else {
                        // Opcional: loguear jugadores sin tag de equipo claro
                        // console.log(`  No se pudo inferir tag de equipo para el jugador: ${playerData.playerName} en ${fileName} (Guardián no incluido)`);
                    }
                }
            }
        });
        console.log(`  Se procesaron ${eventsInThisFile} ${EVENT} en ${fileName}.`);
        totalEventsProcessed += eventsInThisFile;
        }else {
            let eventsInThisFile = 0;
            gameEvents.forEach(event => {
                const gameTime = event.gameTime;
                if (gameTime <= GAMES_TIMES) {
                    if (event.rfc461Schema === "stats_update") { 
                        const participants = event.participants; 
                        participants.forEach(p => {
                            const { x: pixelX, y: pixelY } = transformCoordinates(p.position.x, p.position.z);
                            allEvents.push({ 
                                x: pixelX, y: pixelY, value: HEATMAP_POINT_VALUE,
                                gameTime: gameTime,
                                playerName: p.playerName,
                                teamIdInGame: p.teamID, 
                                actualTeamName: getTeamPrefixFromPlayerName(p.playerName),
                                serieId: seriesInfo.serieId,
                                gameNumberInSerie: seriesInfo.gameNumberInSerie,
                                gameFileName: fileName,
                                value: 45
                            });
                            eventsInThisFile++;
                        });
                    }
                }
            });
            console.log(`  Se procesaron ${eventsInThisFile} ${EVENT} en ${fileName}.`);
            totalEventsProcessed += eventsInThisFile;
        }

        console.log(`\nTotal de eventos procesados: ${totalEventsProcessed}`);
        try {
            fs.writeFileSync(outputFile, JSON.stringify(allEvents, null, 2));
            console.log(`Datos guardados en: ${outputFile}`);
            if (totalEventsProcessed === 0 && jsonlFiles.length > 0) {
                console.warn("ADVERTENCIA: No se procesó ningún evento con un tag de equipo inferible. Revisa los nombres de los jugadores en tus archivos de datos y la regex en getTeamPrefixFromPlayerName.");
            }
        } catch (error) {
            console.error(`Error al escribir ${outputFile}: ${error.message}`);
        }
    }
}

processAllGameData();