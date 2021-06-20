import { DarkMask, Lamp, Lighting, RectangleObject, Vec2 } from 'illuminated';
import $ from 'jquery';
import _ from 'lodash';

import * as Modules from '@kaetram/common/src/modules';

import Character from '../entity/character/character';
import Item from '../entity/objects/item';
import * as Detect from '../utils/detect';
import Camera from './camera';
import Tile from './tile';

import type EntitiesController from '../controllers/entities';
import type InputController from '../controllers/input';
import type Player from '../entity/character/player/player';
import type Entity from '../entity/entity';
import type Sprite from '../entity/sprite';
import type Game from '../game';
import type Map from '../map/map';
import type Splat from './infos/splat';

interface RendererTile {
    relativeTileId: number;
    setWidth: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
}
interface RendererCell {
    dx: number;
    dy: number;
    width: number;
    height: number;
}

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

interface RendererLight {
    origX: number;
    origY: number;
    diff: number;
    relative: boolean;
    computed: boolean;
}

type RendererLamp = RendererLight & Lamp;
// type RendererLighting = RendererLight & Lighting;
interface RendererLighting extends RendererLight, Lighting {
    light: RendererLamp;
}

const HORIZONTAL_FLIP_FLAG = 0x80000000;
const VERTICAL_FLIP_FLAG = 0x40000000;
const DIAGONAL_FLIP_FLAG = 0x20000000;
const ROT_90_DEG = Math.PI / 2;
const ROT_NEG_90_DEG = ROT_90_DEG * -1;
const ROT_180_DEG = Math.PI;

export default class Renderer {
    // canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;

    private context = this.entitiesCanvas.getContext('2d')!; // Entities;

    public backContext = (!Detect.supportsWebGL()
        ? this.background.getContext('2d')
        : this.background.getContext('webgl') || this.background.getContext('experimental-webgl'))!;

    private foreContext = this.foreground.getContext('2d')!; // Foreground
    private overlayContext = this.overlay.getContext('2d')!; // Lighting
    private textContext = this.textCanvas.getContext('2d')!; // Texts
    private cursorContext = this.cursor.getContext('2d')!; // Cursor

    private canvases = [
        this.background,
        this.entitiesCanvas,
        this.foreground,
        this.overlay,
        this.textCanvas,
        this.cursor
    ];

    private allContexts = [
        this.context,
        this.backContext,
        this.foreContext,
        this.overlayContext,
        this.textContext,
        this.cursorContext
    ];

    private contexts = [this.context, this.textContext, this.overlayContext];
    private drawingContexts = [this.backContext, this.foreContext]; // For drawing the map.

    private lightings: RendererLighting[] = [];

    private entities!: EntitiesController;
    public camera!: Camera;
    private input!: InputController;

    public tileSize = 16;
    private fontSize = 16;
    private screenWidth = 0;
    private screenHeight = 0;
    private time = new Date();
    private fps = 0;
    private frameCount = 0;
    private renderedFrame = [0, 0];
    // lastTarget = [0, 0];

    private animatedTiles: { [index: number]: Tile } = {};
    private drawnTiles: Tile[] = [];

    private resizeTimeout: number | null = null;

    public autoCentre = false;
    // drawTarget = false;
    // selectedCellVisible = false;
    private stopRendering = false;
    private animateTiles = true;
    public debugging = false;
    private brightness = 100;
    public drawNames = true;
    public drawLevels = true;
    public forceRendering = false;
    // animatedTilesDrawCalls = 0;

    private tiles: { [id: string]: RendererTile } = {};
    private cells: { [id: number]: RendererCell } = {};

    private scale!: number;
    private superScaling!: number;
    private lightTileSize!: number;
    public canvasHeight!: number;
    public canvasWidth!: number;
    private webGL!: boolean;
    public map!: Map;
    private mEdge!: boolean;
    private tablet!: boolean;
    public mobile!: boolean;
    private darkMask!: DarkMask;
    private shadowSprite!: Sprite;
    private sparksSprite!: Sprite;
    private realFPS!: number;
    public transitioning!: boolean;
    private transitionInterval!: number;
    private tileset: unknown;

    public constructor(
        public background: HTMLCanvasElement,
        public entitiesCanvas: HTMLCanvasElement,
        public foreground: HTMLCanvasElement,
        public overlay: HTMLCanvasElement,
        public textCanvas: HTMLCanvasElement,
        public cursor: HTMLCanvasElement,
        public game: Game
    ) {
        this.load();
    }

    public stop(): void {
        this.camera = null!;
        this.input = null!;
        this.stopRendering = true;

        this.forEachContext((context) => {
            context.fillStyle = '#12100D';
            context.fillRect(0, 0, context.canvas.width, context.canvas.height);
        });
    }

    private load(): void {
        this.scale = this.getScale();
        this.superScaling = this.getSuperScaling();

        this.loadLights();
        this.checkDevice();
    }

    private removeSmoothing(): void {
        this.forAllContexts((context) => {
            if (!context) return;

            context.imageSmoothingQuality = 'low';

            context.imageSmoothingEnabled = false;
            /** @deprecated */
            // ctx.webkitImageSmoothingEnabled = false;
            // ctx.mozImageSmoothingEnabled = false;
            // ctx.msImageSmoothingEnabled = false;
            // ctx.oImageSmoothingEnabled = false;
        });
    }

    private loadSizes(): void {
        if (!this.camera) return;

        this.lightTileSize = this.tileSize * this.superScaling;

        this.screenWidth = this.camera.gridWidth * this.tileSize;
        this.screenHeight = this.camera.gridHeight * this.tileSize;

        this.canvasWidth = this.screenWidth * this.superScaling;
        this.canvasHeight = this.screenHeight * this.superScaling;

        this.forEachCanvas((canvas) => {
            canvas.width = this.canvasWidth;
            canvas.height = this.canvasHeight;
        });

        if (this.webGL) this.map.loadWebGL(this.backContext as WebGL2RenderingContext);
    }

    public loadCamera(): void {
        const { storage } = this.game;

        this.camera = new Camera(this);

        this.loadSizes();

        if (!storage.data.new) return;

        if (this.mEdge || Detect.useCenteredCamera()) {
            this.camera.centered = false;

            storage.data.settings.centerCamera = false;
            storage.save();
        }
    }

    private loadLights(): void {
        this.darkMask = new DarkMask({
            lights: [],
            color: 'rgba(0, 0, 0, 0.84)'
        });

        this.darkMask.compute(this.overlay.width, this.overlay.height);
    }

    public resize(): void {
        this.stopRendering = true;

        this.clear();

        this.checkDevice();

        if (!this.resizeTimeout)
            this.resizeTimeout = window.setTimeout(() => {
                this.scale = this.getScale();
                this.clearScreen(this.cursorContext);

                this.camera.update();

                this.loadSizes();

                this.game.sendClientData();

                this.entities?.update();

                this.camera.centreOn(this.game.player);

                this.game.menu.resize();

                this.stopRendering = false;
                this.resizeTimeout = null;

                this.updateAnimatedTiles();

                this.forceRendering = true;
            }, 500);
    }

    public render(): void {
        if (this.stopRendering) return;

        this.clear();
        this.save();

        this.removeSmoothing();

        /**
         * Rendering related draws
         */

        this.draw();

        this.drawAnimatedTiles();

        this.drawDebugging();

        this.drawOverlays();

        this.drawTargetCell();

        this.drawSelectedCell();

        this.drawEntities();

        this.drawInfos();

        this.drawCursor();

        this.calculateFPS();

        this.restore();
    }

    /**
     * Context Drawing
     */

    private draw(): void {
        if (this.webGL) {
            // Do the WebGL Rendering here
            this.drawWebGL();
            return;
        }

        // Canvas rendering.
        if (this.hasRenderedFrame()) return;

        this.clearDrawing();
        this.saveDrawing();

        this.updateDrawingView();

        this.forEachVisibleTile((id, index) => {
            const isHighTile = this.map.isHighTile(id);
            let context = isHighTile ? this.foreContext : this.backContext;

            // Only do the lighting logic if there is an overlay.
            if (this.game.overlays.getFog()) {
                const isLightTile = this.map.isLightTile(id);

                context = isLightTile ? this.overlayContext : context;
            }

            if (!this.map.isAnimatedTile(id) || !this.animateTiles)
                this.drawTile(context as CanvasRenderingContext2D, id, index);
        });

        this.restoreDrawing();

        this.saveFrame();
    }

    private drawWebGL(): void {
        if (!this.map.webGLMap) return;

        const dt = this.game.time - this.game.lastTime;

        this.game.lastTime = this.game.time;

        this.map.webGLMap.tileScale = 3;

        this.map.webGLMap.update(dt);
        this.map.webGLMap.draw(this.camera.x, this.camera.y);

        // This is a janky and temporary solution to drawing high tiles
        // on the WebGL context.

        this.foreContext.clearRect(0, 0, this.foreground.width, this.foreground.height);
        this.foreContext.save();

        this.setCameraView(this.foreContext);

        this.forEachVisibleTile((id, index) => {
            if (this.map.isHighTile(id)) this.drawTile(this.foreContext, id, index);
        });

        this.foreContext.restore();
    }

    private drawAnimatedTiles(): void {
        if (!this.animateTiles || this.webGL) return;

        this.context.save();
        this.setCameraView(this.context);

        this.forEachAnimatedTile((tile) => {
            if (!this.camera.isVisible(tile.x, tile.y, 3, 1)) return;

            tile.animate(this.game.time);

            this.drawTile(this.context, tile.id, tile.index);
        });

        this.context.restore();
    }

    private drawOverlays(): void {
        const overlay = this.game.overlays.getFog();

        if (overlay) {
            if (overlay !== 'empty') {
                const img = new Image();
                img.src = overlay;
                this.overlayContext.fillStyle = this.overlayContext.createPattern(img, 'repeat')!;
                this.overlayContext.fillRect(
                    0,
                    0,
                    this.screenWidth * this.superScaling,
                    this.screenHeight * this.superScaling
                );
                this.overlayContext.fill();
            }

            this.overlayContext.globalCompositeOperation = 'lighter';

            this.forEachLighting((lighting) => {
                if (this.inRadius(lighting)) this.drawLighting(lighting);
            });

            this.overlayContext.globalCompositeOperation = 'source-over';
            this.darkMask.render(this.overlayContext);
        }
    }

    private drawInfos(): void {
        if (this.game.info.getCount() === 0) return;

        this.game.info.forEachInfo((info) => {
            const { opacity, text, x, y, fill, stroke } = info as Splat;

            this.textContext.save();
            this.setCameraView(this.textContext);
            this.textContext.globalAlpha = opacity;
            this.drawText(`${text}`, Math.floor(x + 8), Math.floor(y), true, fill, stroke, 26);
            this.textContext.restore();
        });
    }

    private drawDebugging(): void {
        if (!this.debugging) return;

        this.drawFPS();

        if (!this.mobile) {
            this.drawPosition();
            this.drawCollisions();
        }

        this.drawPathing();
    }

    private drawEntities(): void {
        if (this.game.player.dead) return;

        this.setCameraView(this.context);

        this.forEachVisibleEntity((entity) => {
            if (!entity) return;

            if (entity.spriteLoaded) this.drawEntity(entity);
        });
    }

    private drawEntity(entity: Entity): void {
        const {
            sprite,
            currentAnimation: animation,
            renderingData: data,
            angled,
            type,
            angle,
            shadowOffsetY,
            fading,
            fadingAlpha,
            spriteFlipX,
            spriteFlipY,
            customScale
        } = entity;

        if (!sprite || !animation || !entity.isVisible()) return;

        const frame = animation.currentFrame;
        const x = frame.x * this.superScaling;
        const y = frame.y * this.superScaling;
        const dx = entity.x * this.superScaling;
        const dy = entity.y * this.superScaling;
        const flipX = dx + this.tileSize * this.superScaling;
        const flipY = dy + data.height;

        this.context.save();

        if (data.sprite !== sprite) {
            data.sprite = sprite;

            data.width = sprite.width * this.superScaling;
            data.height = sprite.height * this.superScaling;
            data.ox = sprite.offsetX * this.superScaling;
            data.oy = sprite.offsetY * this.superScaling;

            if (angled && type !== 'projectile') data.angle = (angle * Math.PI) / 180;

            if (entity.hasShadow()) {
                data.shadowWidth = this.shadowSprite.width * this.superScaling;
                data.shadowHeight = this.shadowSprite.height * this.superScaling;

                data.shadowOffsetY = shadowOffsetY * this.superScaling;
            }
        }

        if (fading) this.context.globalAlpha = fadingAlpha;

        if (spriteFlipX) {
            this.context.translate(flipX, dy);
            this.context.scale(-1, 1);
        } else if (spriteFlipY) {
            this.context.translate(dx, flipY);
            this.context.scale(1, -1);
        } else this.context.translate(dx, dy);

        if (customScale) this.context.scale(customScale, customScale);

        if (angled) this.context.rotate(type === 'projectile' ? entity.getAngle() : data.angle);

        if (entity.hasShadow()) {
            this.context.globalCompositeOperation = 'source-over';

            this.context.drawImage(
                this.shadowSprite.image,
                0,
                0,
                data.shadowWidth,
                data.shadowHeight,
                0,
                data.shadowOffsetY,
                data.shadowWidth,
                data.shadowHeight
            );
        }

        // this.drawEntityBack(entity);

        this.context.drawImage(
            sprite.image,
            x,
            y,
            data.width,
            data.height,
            data.ox,
            data.oy,
            data.width,
            data.height
        );

        this.drawEntityFore(entity);

        this.context.restore();

        this.drawHealth(entity as Character);

        if (!this.game.overlays.getFog()) this.drawName(entity as Player & Item);
    }

    // /**
    //  * Function used to draw special effects prior
    //  * to rendering the entity.
    //  */
    // private drawEntityBack(entity: Entity): void {}

    /**
     * Function used to draw special effects after
     * having rendererd the entity
     */
    private drawEntityFore(entity: Entity): void {
        if (entity instanceof Character) {
            if (entity.hasWeapon() && !entity.dead && !entity.teleporting) {
                const weapon = this.entities.getSprite(entity.weapon.getString());

                if (weapon) {
                    if (!weapon.loaded) weapon.load();

                    const animation = entity.currentAnimation!;
                    const weaponAnimationData = weapon.animationData[animation.name];
                    const frame = animation.currentFrame;
                    const index =
                        frame.index < weaponAnimationData.length
                            ? frame.index
                            : frame.index % weaponAnimationData.length;
                    const weaponX = weapon.width * index * this.superScaling;
                    const weaponY = weapon.height * animation.row * this.superScaling;
                    const weaponWidth = weapon.width * this.superScaling;
                    const weaponHeight = weapon.height * this.superScaling;

                    this.context.drawImage(
                        weapon.image,
                        weaponX,
                        weaponY,
                        weaponWidth,
                        weaponHeight,
                        weapon.offsetX * this.superScaling,
                        weapon.offsetY * this.superScaling,
                        weaponWidth,
                        weaponHeight
                    );
                }
            }

            if (entity.hasEffect()) {
                const sprite = this.entities.getSprite(entity.getActiveEffect());

                if (sprite) {
                    if (!sprite.loaded) sprite.load();

                    const animation = entity.getEffectAnimation()!;
                    const { index } = animation.currentFrame;
                    const x = sprite.width * index * this.superScaling;
                    const y = sprite.height * animation.row * this.superScaling;
                    const width = sprite.width * this.superScaling;
                    const height = sprite.height * this.superScaling;
                    const offsetX = sprite.offsetX * this.superScaling;
                    const offsetY = sprite.offsetY * this.superScaling;

                    this.context.drawImage(
                        sprite.image,
                        x,
                        y,
                        width,
                        height,
                        offsetX,
                        offsetY,
                        width,
                        height
                    );

                    animation.update(this.game.time);
                }
            }
        }

        if (entity instanceof Item) {
            const { sparksAnimation } = this.entities.sprites;
            const sparksFrame = sparksAnimation.currentFrame;
            const sparksX = this.sparksSprite.width * sparksFrame.index * this.superScaling;
            const sparksY = this.sparksSprite.height * sparksAnimation.row * this.superScaling;
            const sparksWidth = this.sparksSprite.width * this.superScaling;
            const sparksHeight = this.sparksSprite.height * this.superScaling;

            this.context.drawImage(
                this.sparksSprite.image,
                sparksX,
                sparksY,
                sparksWidth,
                sparksHeight,
                0,
                0,
                sparksWidth,
                sparksHeight
            );
        }
    }

    private drawHealth(entity: Character): void {
        if (!entity.hitPoints || entity.hitPoints < 0 || !entity.healthBarVisible) return;

        const barLength = 16;
        const healthX = entity.x * this.superScaling - barLength / 2 + 8;
        const healthY = (entity.y - entity.sprite.height / 4) * this.superScaling;
        const healthWidth = Math.round(
            (entity.hitPoints / entity.maxHitPoints) * barLength * this.superScaling
        );
        const healthHeight = 2 * this.superScaling;

        this.textContext.save();
        this.setCameraView(this.textContext);
        this.textContext.strokeStyle = '#00000';
        this.textContext.lineWidth = 1;
        this.textContext.strokeRect(healthX, healthY, barLength * this.superScaling, healthHeight);
        this.textContext.fillStyle = '#FD0000';
        this.textContext.fillRect(healthX, healthY, healthWidth, healthHeight);
        this.textContext.restore();
    }

    private drawName(entity: Player & Item): void {
        if (entity.hidden || !entity.drawNames() || (!this.drawNames && !this.drawLevels)) return;

        let colour = entity.wanted ? 'red' : 'white';

        if (entity.rights > 1) colour = '#ba1414';
        else if (entity.rights > 0) colour = '#a59a9a';

        if (entity.id === this.game.player.id) colour = '#fcda5c';

        if (entity.nameColour) colour = entity.nameColour;

        this.textContext.save();
        this.setCameraView(this.textContext);
        this.textContext.font = '11px AdvoCut';

        if (!entity.hasCounter) {
            const x = entity.x + 8;
            const y = entity.y - Math.floor(entity.sprite.height / 3);

            if (this.drawNames && entity instanceof Character)
                this.drawText(
                    entity.name,
                    x,
                    this.drawLevels && entity.type !== 'npc' ? y - 8 : y,
                    true,
                    colour,
                    '#000'
                );

            if (this.drawLevels && (entity.type === 'mob' || entity.type === 'player'))
                this.drawText(`Level ${entity.level}`, x, y, true, colour, '#000');

            if (entity.type === 'item') {
                if (entity.count > 1) this.drawText(entity.count.toString(), x, y, true, colour);

                if (entity.ability > -1)
                    this.drawText(
                        `${Modules.EnchantmentNames[entity.ability]} [+${entity.abilityLevel}]`,
                        x,
                        entity.y + 20,
                        true,
                        colour
                    );
            }
        } else {
            // TODO - Move this countdown elsewhere.
            if (this.game.time - entity.countdownTime > 1000) {
                entity.countdownTime = this.game.time;
                entity.counter--;
            }

            if (entity.counter <= 0) entity.hasCounter = false;

            this.drawText(entity.counter.toString(), entity.x + 8, entity.y - 10, true, colour);
        }

        this.textContext.restore();
    }

    private drawLighting(lighting: RendererLighting): void {
        if (lighting.relative) {
            const lightX = (lighting.light.origX - this.camera.x / 16) * this.lightTileSize;
            const lightY = (lighting.light.origY - this.camera.y / 16) * this.lightTileSize;

            lighting.light.position = new Vec2(lightX, lightY);
            lighting.compute(this.overlay.width, this.overlay.height);
            this.darkMask.compute(this.overlay.width, this.overlay.height);
        } else if (!lighting.computed) {
            lighting.compute(this.overlay.width, this.overlay.height);
            lighting.computed = true;
        }

        lighting.render(this.overlayContext);
    }

    private drawCursor(): void {
        const { input, cursorContext, tablet, mobile, superScaling } = this;

        if (tablet || mobile || this.hasRenderedMouse() || input.cursorMoved) return;

        const { cursor, mouse } = input;
        const scaling = 14 * superScaling;

        this.clearScreen(cursorContext);
        cursorContext.save();

        if (cursor) {
            if (!cursor.loaded) cursor.load();

            if (cursor.loaded)
                cursorContext.drawImage(
                    cursor.image,
                    0,
                    0,
                    scaling,
                    scaling,
                    mouse.x,
                    mouse.y,
                    scaling,
                    scaling
                );
        }

        cursorContext.restore();

        this.saveMouse();
    }

    private calculateFPS(): void {
        if (!this.debugging) return;

        const currentTime = new Date();
        const timeDiff = currentTime.getTime() - this.time.getTime();

        if (timeDiff >= 1000) {
            this.realFPS = this.frameCount;
            this.frameCount = 0;
            this.time = currentTime;
            this.fps = this.realFPS;
        }

        this.frameCount++;
    }

    private drawFPS(): void {
        this.drawText(`FPS: ${this.realFPS}`, 10, 31, false, 'white');
    }

    private drawPosition(): void {
        const { player } = this.game;

        this.drawText(
            `x: ${player.gridX} y: ${player.gridY} tileIndex: ${this.map.gridPositionToIndex(
                player.gridX,
                player.gridY
            )}`,
            10,
            51,
            false,
            'white'
        );

        if (this.input.hoveringEntity) {
            const { x, y } = this.input.getCoords()!;

            this.drawText(
                `x: ${x} y: ${y} instance: ${this.input.hoveringEntity.id}`,
                10,
                71,
                false,
                'white'
            );
            this.drawText(
                `attack range: ${this.input.hoveringEntity.attackRange}`,
                10,
                91,
                false,
                'white'
            );
        }
    }

    private drawCollisions(): void {
        const { pathingGrid } = this.entities.grids;

        if (!pathingGrid) return;

        this.camera.forEachVisiblePosition((x, y) => {
            if (x < 0 || y < 0 || x > this.map.width - 1 || y > this.map.height - 1) return;

            if (pathingGrid[y][x] !== 0) this.drawCellHighlight(x, y, 'rgba(50, 50, 255, 0.5)');
        });
    }

    private drawPathing(): void {
        if (!this.game.player.hasPath()) return;

        _.each(this.game.player.path, (path) =>
            this.drawCellHighlight(path[0], path[1], 'rgba(50, 255, 50, 0.5)')
        );
    }

    private drawSelectedCell(): void {
        if (!this.input.selectedCellVisible || this.input.keyMovement) return;

        // const posX = this.input.selectedX,
        //     posY = this.input.selectedY,
        const tD = this.input.getTargetData(); // target data

        if (tD) {
            this.context.save();
            this.setCameraView(this.context);

            this.context.drawImage(
                tD.sprite.image,
                tD.x,
                tD.y,
                tD.width,
                tD.height,
                tD.dx,
                tD.dy,
                tD.dw,
                tD.dh
            );

            this.context.restore();
        }
    }

    /**
     * Primitive drawing functions
     */

    private drawTile(context: CanvasRenderingContext2D, tileId: number, cellId: number): void {
        const originalTileId = tileId;
        let rotation!: number;

        /**
         * `originalTileId` is the tileId prior to doing any
         * bitwise operations (for rotations).
         */

        if (tileId < 0) return;

        if (tileId > DIAGONAL_FLIP_FLAG) {
            if (!(tileId & HORIZONTAL_FLIP_FLAG)) rotation = ROT_NEG_90_DEG;

            if (!(tileId & VERTICAL_FLIP_FLAG)) rotation = ROT_90_DEG;

            if (!(tileId & DIAGONAL_FLIP_FLAG)) rotation = ROT_180_DEG;

            tileId &= ~(HORIZONTAL_FLIP_FLAG | VERTICAL_FLIP_FLAG | DIAGONAL_FLIP_FLAG);
        }

        const tileset = this.map.getTilesetFromId(tileId);

        if (!tileset) return;

        /**
         * Removed tilesetScale (tileset.scale) variables since it
         * is generally always 1. The reason for the variable was
         * due to the usage of the large PNG file, which Chrome
         * split up and messed with.
         */

        if (!(originalTileId in this.tiles)) {
            const setWidth = tileset.width / this.tileSize;
            const relativeTileId = tileId - tileset.firstGID + 1;

            this.tiles[originalTileId] = {
                relativeTileId,
                setWidth,
                x: this.getX(relativeTileId + 1, setWidth) * this.tileSize,
                y: Math.floor(relativeTileId / setWidth) * this.tileSize,
                width: this.tileSize,
                height: this.tileSize,
                rotation
            };
        }

        if (!(cellId in this.cells)) {
            const scale = this.superScaling;

            this.cells[cellId] = {
                dx: this.getX(cellId + 1, this.map.width) * this.tileSize * scale,
                dy: Math.floor(cellId / this.map.width) * this.tileSize * scale,
                width: this.tileSize * scale,
                height: this.tileSize * scale
            };
        }

        this.drawImage(context, tileset, this.tiles[originalTileId], this.cells[cellId]);
    }

    private drawImage(
        context: CanvasRenderingContext2D,
        image: CanvasImageSource,
        tile: RendererTile,
        cell: RendererCell
    ): void {
        // const scale = this.superScaling;
        let dx!: number;
        let dy!: number; // this.superScaling * 1.5;

        if (!context) return;

        if (tile.rotation) {
            context.save();
            context.rotate(tile.rotation);

            ({ dx, dy } = cell);

            const temporary = cell.dx;

            switch (tile.rotation) {
                case ROT_180_DEG:
                    context.translate(-cell.width, -cell.height);

                    (dx = -dx), (dy = -dy);

                    break;

                case ROT_90_DEG:
                    context.translate(0, -cell.height);

                    (dx = dy), (dy = -temporary);

                    break;

                case ROT_NEG_90_DEG:
                    context.translate(-cell.width, 0);

                    (dx = -dy), (dy = temporary);

                    break;
            }
        }

        context.drawImage(
            image,
            tile.x, // Source X
            tile.y, // Source Y
            tile.width, // Source Width
            tile.height, // Source Height
            tile.rotation ? dx : cell.dx, // Destination X
            tile.rotation ? dy : cell.dy, // Destination Y
            cell.width, // Destination Width
            cell.height
        ); // Destination Height

        if (tile.rotation) context.restore();
    }

    private drawText(
        text: string,
        x: number,
        y: number,
        centered: boolean,
        colour: string,
        strokeColour?: string,
        fontSize?: number
    ): void {
        const strokeSize = 3;
        const context = this.textContext;

        if (text && x && y) {
            context.save();

            if (centered) context.textAlign = 'center';

            context.strokeStyle = strokeColour || '#373737';
            context.lineWidth = strokeSize;
            context.font = `${fontSize || this.fontSize}px AdvoCut`;
            context.strokeText(text, x * this.superScaling, y * this.superScaling);
            context.fillStyle = colour || 'white';
            context.fillText(text, x * this.superScaling, y * this.superScaling);

            context.restore();
        }
    }

    public updateAnimatedTiles(): void {
        if (!this.animateTiles || this.webGL) return;

        this.forEachVisibleTile((id, index) => {
            /**
             * We don't want to reinitialize animated tiles that already exist
             * and are within the visible camera proportions. This way we can parse
             * it every time the tile moves slightly.
             */

            if (!this.map.isAnimatedTile(id)) return;

            /**
             * Push the pre-existing tiles.
             */

            if (!(index in this.animatedTiles)) {
                const tile = new Tile(id, index, this.map);
                const position = this.map.indexToGridPosition(tile.index);

                tile.setPosition(position);

                this.animatedTiles[index] = tile;
            }
        }, 2);
    }

    private drawCellRect(x: number, y: number, colour: string): void {
        const multiplier = this.tileSize * this.superScaling;

        this.context.save();
        this.setCameraView(this.context);

        this.context.lineWidth = 2 * this.superScaling;

        this.context.translate(x + 2, y + 2);

        this.context.strokeStyle = colour;
        this.context.strokeRect(0, 0, multiplier - 4, multiplier - 4);

        this.context.restore();
    }

    private drawCellHighlight(x: number, y: number, colour: string): void {
        this.drawCellRect(
            x * this.superScaling * this.tileSize,
            y * this.superScaling * this.tileSize,
            colour
        );
    }

    private drawTargetCell(): void {
        if (
            this.mobile ||
            this.tablet ||
            !this.input.targetVisible ||
            !this.input ||
            !this.camera ||
            !this.map ||
            this.input.keyMovement
        )
            return;

        const location = this.input.getCoords()!;

        if (!(location.x === this.input.selectedX && location.y === this.input.selectedY)) {
            const isColliding = this.map.isColliding(location.x, location.y);

            this.drawCellHighlight(
                location.x,
                location.y,
                isColliding ? 'rgba(230, 0, 0, 0.7)' : this.input.targetColour
            );
        }
    }

    /**
     * Primordial Rendering functions
     */

    private forEachVisibleIndex(callback: (index: number) => void, offset?: number): void {
        this.camera.forEachVisiblePosition((x, y) => {
            if (!this.map.isOutOfBounds(x, y)) callback(this.map.gridPositionToIndex(x, y) - 1);
        }, offset);
    }

    private forEachVisibleTile(
        callback: (data: number, index: number) => void,
        offset?: number
    ): void {
        if (!this.map || !this.map.mapLoaded) return;

        this.forEachVisibleIndex((index) => {
            const indexData = this.map.data[index];

            if (Array.isArray(indexData)) for (const data of indexData) callback(data - 1, index);
            else if (!isNaN(this.map.data[index] - 1)) callback(this.map.data[index] - 1, index);
        }, offset);
    }

    private forEachAnimatedTile(callback: (tile: Tile) => void): void {
        _.each(this.animatedTiles, callback);
    }

    private forEachVisibleEntity(callback: (entity: Entity) => void): void {
        if (!this.entities || !this.camera) return;

        const { grids } = this.entities;

        this.camera.forEachVisiblePosition((x, y) => {
            if (!this.map.isOutOfBounds(x, y) && grids.renderingGrid[y][x])
                _.each(grids.renderingGrid[y][x], (entity: Entity) => callback(entity));
        });
    }

    public getScale(): number {
        return this.game.getScaleFactor();
    }

    public getSuperScaling(): number {
        return 3;
    }

    private clear(): void {
        this.forEachContext((context) =>
            context.clearRect(0, 0, context.canvas.width, context.canvas.height)
        );
    }

    private clearText(): void {
        this.textContext.clearRect(0, 0, this.textCanvas.width, this.textCanvas.height);
        this.overlayContext.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    private clearDrawing(): void {
        this.forEachDrawingContext((context) =>
            context.clearRect(0, 0, context.canvas.width, context.canvas.height)
        );
    }

    private save(): void {
        this.forEachContext((context) => context.save());
    }

    private saveDrawing(): void {
        this.forEachDrawingContext((context) => context.save());
    }

    private restore(): void {
        this.forEachContext((context) => context.restore());
    }

    private restoreDrawing(): void {
        this.forEachDrawingContext((context) => context.restore());
    }

    private hasRenderedFrame(): boolean {
        if (this.forceRendering || (this.mobile && this.camera.centered)) return false;

        if (!this.camera || this.stopRendering || !this.input) return true;

        return this.renderedFrame[0] === this.camera.x && this.renderedFrame[1] === this.camera.y;
    }

    private saveFrame(): void {
        if (this.mobile && this.camera.centered) return;

        this.renderedFrame[0] = this.camera.x;
        this.renderedFrame[1] = this.camera.y;

        this.forceRendering = false;
    }

    private transition(duration: number, forward: boolean, callback: () => void): void {
        const textCanvas = $('#textCanvas');
        const hasThreshold = () => (forward ? this.brightness > 99 : this.brightness < 1);
        this.transitioning = true;

        this.transitionInterval = window.setInterval(() => {
            this.brightness += forward ? 6 : -6;

            textCanvas.css('background', `rgba(0,0,0,${1 - this.brightness / 100})`);

            if (hasThreshold()) {
                clearInterval(this.transitionInterval);
                this.transitionInterval = null!;

                this.transitioning = false;

                callback();
            }
        }, duration);
    }

    /**
     * Rendering Functions
     */

    private updateView(): void {
        this.forEachContext((context) => this.setCameraView(context));
    }

    private updateDrawingView(): void {
        this.forEachDrawingContext((context) => this.setCameraView(context));
    }

    private setCameraView(context: CanvasRenderingContext2D): void {
        if (!this.camera || this.stopRendering) return;

        context.translate(-this.camera.x * this.superScaling, -this.camera.y * this.superScaling);
    }

    private clearScreen(context: CanvasRenderingContext2D): void {
        context.clearRect(0, 0, this.context.canvas.width, this.context.canvas.height);
    }

    private hasRenderedMouse(): boolean {
        return (
            this.input.lastMousePosition.x === this.input.mouse.x &&
            this.input.lastMousePosition.y === this.input.mouse.y
        );
    }

    private saveMouse(): void {
        this.input.lastMousePosition.x = this.input.mouse.x;
        this.input.lastMousePosition.y = this.input.mouse.y;
    }

    public adjustBrightness(level: number): void {
        if (level < 0 || level > 100) return;

        $('#textCanvas').css('background', `rgba(0, 0, 0, ${0.5 - level / 200})`);
    }

    public loadStaticSprites(): void {
        this.shadowSprite = this.entities.getSprite('shadow16')!;

        if (!this.shadowSprite.loaded) this.shadowSprite.load();

        this.sparksSprite = this.entities.getSprite('sparks')!;

        if (!this.sparksSprite.loaded) this.sparksSprite.load();
    }

    hasDrawnTile(id: Tile): boolean {
        return this.drawnTiles.includes(id);
    }

    /**
     * Miscellaneous functions
     */

    private forAllContexts(callback: (context: CanvasRenderingContext2D) => void): void {
        _.each(this.allContexts, (context) => callback(context as CanvasRenderingContext2D));
    }

    private forEachContext(callback: (context: CanvasRenderingContext2D) => void): void {
        _.each(this.contexts, callback);
    }

    private forEachDrawingContext(callback: (context: CanvasRenderingContext2D) => void): void {
        _.each(this.drawingContexts, (context) => callback(context as CanvasRenderingContext2D));
    }

    private forEachCanvas(callback: (canvas: HTMLCanvasElement) => void): void {
        _.each(this.canvases, callback);
    }

    private forEachLighting(callback: (lighting: RendererLighting) => void): void {
        _.each(this.lightings, callback);
    }

    private getX(index: number, width: number): number {
        if (index === 0) return 0;

        return index % width === 0 ? width - 1 : (index % width) - 1;
    }

    private checkDevice(): void {
        this.mobile = Detect.isMobile();
        this.tablet = Detect.isTablet();
        this.mEdge = Detect.isEdge();
        this.webGL = Detect.supportsWebGL();

        // this.animateTiles = !this.mEdge;
    }

    public verifyCentration(): void {
        this.forceRendering = (this.mobile || this.tablet) && this.camera.centered;
    }

    public isPortableDevice(): boolean {
        return this.mobile || this.tablet;
    }

    public updateDarkMask(color: string): void {
        this.darkMask.color = color;
        this.darkMask.compute(this.overlay.width, this.overlay.height);
    }

    private parseObjects(objects: Pos[]): RectangleObject[] {
        const parsedObjects: RectangleObject[] = [];

        if (!objects) return parsedObjects;

        for (const object of objects)
            parsedObjects.push(
                new RectangleObject({
                    topleft: new Vec2(object.x, object.y),
                    bottomright: new Vec2(object.x + this.tileSize, object.y + this.tileSize)
                })
            );

        return parsedObjects;
    }

    public addLight(
        x: number,
        y: number,
        distance: number,
        diffuse: number,
        color: string,
        relative: boolean,
        objects?: Pos[]
    ): void {
        const light = new Lamp(this.getLightData(x, y, distance, diffuse, color)) as RendererLamp;
        const lighting = new Lighting({
            light,
            objects: this.parseObjects(objects!)
            // diffuse: light.diffuse
        }) as RendererLighting;

        light.origX = light.position.x;
        light.origY = light.position.y;

        light.diff = Math.round(light.distance / 16);

        if (this.hasLighting(lighting)) return;

        if (relative) lighting.relative = relative;

        this.lightings.push(lighting);
        this.darkMask.lights.push(light);

        this.drawLighting(lighting);
        this.darkMask.compute(this.overlay.width, this.overlay.height);
    }

    public removeAllLights(): void {
        this.lightings = [];
        this.darkMask.lights = [];

        this.darkMask.compute(this.overlay.width, this.overlay.height);
    }

    public removeNonRelativeLights(): void {
        _.each(this.lightings, (lighting, index) => {
            if (!lighting.light.relative) {
                this.lightings.splice(index, 1);
                this.darkMask.lights.splice(index, 1);
            }
        });

        this.darkMask.compute(this.overlay.width, this.overlay.height);
    }

    private getLightData(
        x: number,
        y: number,
        distance: number,
        diffuse: number,
        color: string
    ): Partial<Lamp> {
        return {
            position: new Vec2(x, y),
            distance,
            diffuse,
            color,
            radius: 0,
            samples: 2,
            roughness: 0,
            angle: 0
        };
    }

    private hasLighting(lighting: RendererLighting): boolean {
        for (let index = 0; index < this.lightings.length; index++) {
            const { light } = this.lightings[index];

            if (
                lighting.light.origX === light.origX &&
                lighting.light.origY === light.origY &&
                lighting.light.distance === light.distance
            )
                return true;
        }

        return false;
    }

    private inRadius(lighting: RendererLighting): boolean {
        const position = {
            x: lighting.light.origX,
            y: lighting.light.origY,
            diff: lighting.light.diff
        };

        return (
            position.x > this.camera.gridX - position.diff &&
            position.x < this.camera.gridX + this.camera.gridWidth + position.diff &&
            position.y > this.camera.gridY - position.diff &&
            position.y < this.camera.gridY + this.camera.gridHeight + position.diff
        );
    }

    public getMiddle(): Pos {
        return {
            x: this.overlay.width / 2,
            y: this.overlay.height / 2
        };
    }

    /**
     * Setters
     */

    public setTileset(tileset: unknown): void {
        this.tileset = tileset;
    }

    public setMap(map: Map): void {
        this.map = map;
    }

    public setEntities(entities: EntitiesController): void {
        this.entities = entities;
    }

    public setInput(input: InputController): void {
        this.input = input;
    }

    /**
     * Getters
     */

    public getTargetBounds(tx: number, ty: number): Bounds {
        const sx = tx || this.input.selectedX;
        const sy = ty || this.input.selectedY;

        const x = (sx * this.tileSize - this.camera.x) * this.superScaling;
        const y = (sy * this.tileSize - this.camera.y) * this.superScaling;
        const width = this.tileSize * this.superScaling;
        const height = this.tileSize * this.superScaling;

        const bounds: Bounds = {
            x,
            y,
            width,
            height,
            left: x,
            right: x + width,
            top: y,
            bottom: y + height
        };

        return bounds;
    }

    public getTileset(): unknown {
        return this.tileset;
    }
}
