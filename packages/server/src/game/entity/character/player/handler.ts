import Item from '../../objects/item';

import log from '@kaetram/common/util/log';
import Utils from '@kaetram/common/util/utils';
import { Modules, Opcodes } from '@kaetram/common/network';
import {
    AbilityPacket,
    AchievementPacket,
    ContainerPacket,
    DeathPacket,
    DespawnPacket,
    EquipmentPacket,
    FriendsPacket,
    NPCPacket,
    OverlayPacket,
    PointsPacket,
    PoisonPacket,
    QuestPacket,
    SkillPacket,
    TradePacketPacket
} from '@kaetram/common/network/impl';

import type Player from './player';
import type NPC from '../../npc/npc';
import type Entity from '../../entity';
import type Map from '../../../map/map';
import type World from '../../../world';
import type Character from '../character';
import type Slot from './containers/slot';
import type Ability from './ability/ability';
import type Equipment from './equipment/equipment';
import type Areas from '../../../map/areas/areas';
import type Light from '../../../globals/impl/light';
import type { Enchantments } from '@kaetram/common/types/item';
import type { ProcessedDoor } from '@kaetram/common/types/map';

export default class Handler {
    private world: World;
    private map: Map;

    private updateTime = 600;

    private updateTicks = 0;
    private updateInterval: NodeJS.Timeout | null = null;

    public constructor(private player: Player) {
        this.world = player.world;
        this.map = player.world.map;

        // Death callback
        this.player.onDeath(this.handleDeath.bind(this));

        // Hit callback
        this.player.onHit(this.handleHit.bind(this));
        this.player.combat.onAttack(this.handleAttack.bind(this));

        // Movement-related callbacks
        this.player.onDoor(this.handleDoor.bind(this));
        this.player.onMovement(this.handleMovement.bind(this));

        // Region callback
        this.player.onRegion(this.handleRegion.bind(this));
        this.player.onRecentRegions(this.handleRecentRegions.bind(this));

        // Loading callbacks
        this.player.equipment.onLoaded(this.handleEquipment.bind(this));
        this.player.inventory.onLoaded(this.handleInventory.bind(this));
        this.player.bank.onLoaded(this.handleBank.bind(this));
        this.player.quests.onLoaded(this.handleQuests.bind(this));
        this.player.achievements.onLoaded(this.handleAchievements.bind(this));
        this.player.skills.onLoaded(this.handleSkills.bind(this));
        this.player.abilities.onLoaded(this.handleAbilities.bind(this));

        // Inventory callbacks
        this.player.inventory.onAdd(this.handleInventoryAdd.bind(this));
        this.player.inventory.onRemove(this.handleInventoryRemove.bind(this));
        this.player.inventory.onNotify(this.player.notify.bind(this.player));

        // Bank callbacks
        this.player.bank.onAdd(this.handleBankAdd.bind(this));
        this.player.bank.onRemove(this.handleBankRemove.bind(this));
        this.player.bank.onNotify(this.player.notify.bind(this.player));

        // Friends list callback
        this.player.friends.onLoad(this.handleFriends.bind(this));
        this.player.friends.onAdd(this.handleFriendsAdd.bind(this));
        this.player.friends.onRemove(this.handleFriendsRemove.bind(this));
        this.player.friends.onStatus(this.handleFriendsStatus.bind(this));

        // Equipment callbacks
        this.player.equipment.onEquip(this.handleEquip.bind(this));
        this.player.equipment.onUnequip(this.handleUnequip.bind(this));
        this.player.equipment.onAttackStyle(this.handleAttackStyle.bind(this));

        // Ability callbacks
        this.player.abilities.onAdd(this.handleAbilityAdd.bind(this));
        this.player.abilities.onToggle(this.handleAbilityToggle.bind(this));

        // Trade callbacks
        this.player.trade.onOpen(this.handleTradeOpen.bind(this));
        this.player.trade.onAdd(this.handleTradeAdd.bind(this));
        this.player.trade.onRemove(this.handleTradeRemove.bind(this));
        this.player.trade.onAccept(this.handleTradeAccept.bind(this));

        // NPC talking callback
        this.player.onTalkToNPC(this.handleTalkToNPC.bind(this));

        // Killing a character callback
        this.player.onKill(this.handleKill.bind(this));

        // Poison callback
        this.player.onPoison(this.handlePoison.bind(this));

        // Cheat-score callback
        this.player.onCheatScore(this.handleCheatScore.bind(this));

        // Mana callback
        this.player.mana.onMana(this.handleMana.bind(this));
    }

    /**
     * Called after receiving the ready packet. Signals to the handler that we should
     * start loading our update interval timer.
     */

    public startUpdateInterval(): void {
        this.updateInterval = setInterval(() => {
            if (this.isTickInterval(4)) this.detectAggro();
            if (this.isTickInterval(32)) {
                this.player.loiter();
                this.player.cheatScore = 0;
            }

            this.updateTicks++;
        }, this.updateTime);
    }

    /**
     * Callback for when the player dies.
     */

    private handleDeath(attacker?: Character): void {
        this.player.dead = true;
        this.player.status.clear();

        if (attacker) {
            attacker.clearTarget();
            attacker.removeAttacker(this.player);

            if (attacker.isPlayer()) {
                this.player.statistics.pvpDeaths++;

                // Signal to attacker they just killed a player.
                attacker.killCallback?.(this.player);
            }
        }

        // Send despawn packet to all the nearby entities except the player.
        this.player.sendToRegions(
            new DespawnPacket({
                instance: this.player.instance
            }),
            true
        );

        // Despawn the pet from the world.
        if (this.player.hasPet()) this.world.entities.removePet(this.player.pet!);

        // Clear the player's target.
        this.player.damageTable = {};

        // Remove the poison status.
        this.player.setPoison();

        this.world.cleanCombat(this.player);
        this.player.skills.stop();
        this.player.combat.stop();

        this.player.save();

        // Send death packet only to the player.
        this.player.send(new DeathPacket(this.player.instance));
    }

    /**
     * Callback handler for when the player is hit.
     * @param damage The amount of damage dealt.
     * @param attacker Who is attacking the player.
     * @param isThorns Whether the damage is from thorns.
     */

    private handleHit(damage: number, attacker?: Character, isThorns = false): void {
        if (!attacker || this.player.isDead()) return;

        this.player.addAttacker(attacker);

        // Prevent endless loops of thorn damage.
        if (isThorns) return;

        let thornsLevel = this.player.equipment.getChestplate().getThornsLevel();

        // Stop if we do not have thorns on the armour.
        if (!thornsLevel) return;

        // 40% chance to activate thorns.
        if (Utils.randomInt(0, 100) > 40) return;

        // Thorns damage is 10% per level of thorns enchantment.
        let thornsDamage = Math.floor(damage * thornsLevel * 0.1);

        // Send damage packet to the attacker.
        attacker.hit(thornsDamage, this.player);
    }

    /**
     * Callback for when the player performs an attack.
     */

    private handleAttack(): void {
        if (this.player.isMagic()) {
            let { manaCost } = this.player.equipment.getWeapon();

            // If the player doesn't have enough mana to attack.
            if (!this.player.hasManaForAttack()) {
                // Warn the player once if they don't have enough mana.
                if (!this.player.displayedManaWarning) this.player.notify('misc:LOW_MANA');

                this.player.displayedManaWarning = true;

                return;
            }

            this.player.displayedManaWarning = false;

            this.player.mana.decrement(manaCost);
        }

        if (this.player.isArcher()) {
            if (!this.player.hasArrows()) return this.player.notify('misc:NO_ARROWS');

            this.player.equipment.decrementArrows();
        }
    }

    /**
     * Receive a callback about the door destination coordinate
     * and quest information (if existant).
     */

    private handleDoor(door: ProcessedDoor): void {
        // Reset talking index when passing through any door.
        this.player.talkIndex = 0;

        /**
         * Handles entering through a door that requires a level. If no skill is specified
         * then we use the player's combat level, otherwise we use the level of the skill
         * that was specified.
         */

        if (door.level) {
            let level = door.skill
                    ? this.player.skills.get(Utils.getSkill(door.skill)!).level
                    : this.player.level,
                message = door.skill
                    ? `misc:NO_SKILL_DOOR;skill=${door.skill};level=${door.level}`
                    : `misc:NO_COMBAT_DOOR;level=${door.level}`;

            if (level < door.level) return this.player.notify(message);
        }

        // If a door has a quest, redirect to the quest handler's door callback.
        if (door.quest) {
            let quest = this.player.quests.get(door.quest);

            return quest.doorCallback?.(door, this.player);
        }

        // If the door has an achievement associated with it, it gets completed here.
        if (door.achievement) this.player.achievements.get(door.achievement)?.finish();

        // Some doors may require players to complete achievements before they can pass through.
        if (door.reqAchievement) {
            let achievement = this.player.achievements.get(door.reqAchievement);

            if (!achievement?.isFinished())
                return this.player.notify(
                    `misc:NO_ACHIEVEMENT_DOOR;achievement=${achievement?.name}`
                );
        }

        // Ensure quest requirement is fullfilled before passing through the door.
        if (door.reqQuest) {
            let quest = this.player.quests.get(door.reqQuest);

            if (!quest?.isFinished())
                return this.player.notify(`misc:NO_QUEST_DOOR;quest=${quest?.name}`);
        }

        // Handle door requiring an item to proceed (and remove the item from the player's inventory).
        if (door.reqItem) {
            let count = door.reqItemCount || 1;

            if (!this.player.inventory.hasItem(door.reqItem, count))
                return this.player.notify('misc:NO_KEY_DOOR');

            this.player.inventory.removeItem(door.reqItem, count);

            this.player.notify('misc:DOOR_KEY_CRUMBLES');
        }

        this.player.teleport(door.x, door.y);

        log.debug(`[${this.player.username}] Going through door: ${door.x} - ${door.y}`);
    }

    /**
     * Handles the player's movement and passes new position as parameters.
     * @param x The new x grid position.
     * @param y The new y grid position.
     */

    private handleMovement(x: number, y: number): void {
        this.map.regions.handle(this.player);

        // Prevent out of bounds (placeholder coordinates) from being processed.
        if (this.map.isOutOfBounds(x, y)) return;

        this.detectAggro();
        this.detectAreas(x, y);

        this.player.storeOpen = '';
        this.player.plateauLevel = this.map.getPlateauLevel(x, y);

        // Make the pet follow the player with every movement.
        if (this.player.hasPet()) {
            let distance = this.player.getDistance(this.player.pet!);

            // Send a new follow packet if the pet is too far away.
            if (distance > 2) this.player.pet?.follow(this.player);

            // If the distance exceeds 10 tiles, we despawn and respawn the pet.
            if (distance > 10) {
                this.world.entities.removePet(this.player.pet!);
                this.player.pet = this.world.entities.spawnPet(this.player, this.player.pet!.key);

                this.player.pet?.follow(this.player);
            }
        }
    }

    /**
     * Callback for when a region has changed.
     * @param region The new region.
     */

    private handleRegion(region: number): void {
        log.debug(`Player ${this.player.username} entered region: ${region}.`);

        this.handleLights(region);

        this.player.updateEntityList();
        this.player.updateEntityPositions();

        this.player.lastRegionChange = Date.now();
    }

    /**
     * Sends a despawn packet to the regions the player has recently left.
     * @param regions Contains the array of regions the player has recently left.
     */

    private handleRecentRegions(regions: number[]): void {
        //log.debug(`Sending despawn to recent regions: [${regions.join(', ')}].`);

        this.player.sendToRecentRegions(
            new DespawnPacket({
                instance: this.player.instance,
                regions
            })
        );
    }

    /**
     * Callback once the equipments are loaded. Relay the mesasge to the client.
     */

    private handleEquipment(): void {
        this.player.send(
            new EquipmentPacket(Opcodes.Equipment.Batch, {
                data: this.player.equipment.serialize(true)
            })
        );
    }

    /**
     * Callback for when an item is equipped.
     * @param equipment The equipment slot and the data contained.
     */

    private handleEquip(equipment: Equipment): void {
        this.player.send(
            new EquipmentPacket(Opcodes.Equipment.Equip, {
                data: equipment.serialize(true)
            })
        );

        // Sync to nearby players.
        this.player.sync();
    }

    /**
     * Callback for when the equipment is removed.
     * @param type The equipment type we are removing.
     * @param count (Optional) The amount of items we are removing.
     */

    private handleUnequip(type: Modules.Equipment, count?: number): void {
        this.player.send(new EquipmentPacket(Opcodes.Equipment.Unequip, { type, count }));

        // Sync to nearby players.
        this.player.sync();
    }

    /**
     * Callback for when the attack style is changed and needs to be relayed to the client.
     * @param attackStyle The new attack style that the player has selected.
     */

    private handleAttackStyle(attackStyle: Modules.AttackStyle): void {
        this.player.send(
            new EquipmentPacket(Opcodes.Equipment.Style, {
                attackStyle,
                attackRange: this.player.attackRange
            })
        );
    }

    /**
     * Sends a pacet to the client to add a new ability.
     * @param ability The ability that the player is adding.
     */

    private handleAbilityAdd(ability: Ability): void {
        this.player.send(new AbilityPacket(Opcodes.Ability.Add, ability.serialize(true)));
    }

    /**
     * Sends a message to the client to toggle the ability status.
     * @param key The key of the ability we are toggling.
     */

    private handleAbilityToggle(key: string): void {
        this.player.send(new AbilityPacket(Opcodes.Ability.Toggle, { key, level: -1 }));
    }

    /**
     * Callback for when the trade is opened. Relays a message to the player.
     * @param instance The instance of the player we are trading with.
     */

    private handleTradeOpen(instance: string): void {
        this.player.send(new TradePacketPacket(Opcodes.Trade.Open, { instance }));
    }

    /**
     * Callback for when an item is added to the trade.
     * @param instance The instance of the player who is adding the item.
     * @param index The index of the item (in the inventory) that we are adding.
     * @param count The amount of the item we are adding.
     */

    private handleTradeAdd(instance: string, index: number, count: number, key: string): void {
        this.player.send(new TradePacketPacket(Opcodes.Trade.Add, { instance, index, count, key }));
    }

    /**
     * Removes an item from the trade.
     * @param instance The instance of the player who is removing the item.
     * @param index The index of the item in the trade screen that we are removing.
     */

    private handleTradeRemove(instance: string, index: number): void {
        this.player.send(new TradePacketPacket(Opcodes.Trade.Remove, { instance, index }));
    }

    /**
     * Relays a message to the client that the trade has been accepted by one of the players.
     * @param message The message to display in the trade status window.
     */

    private handleTradeAccept(message?: string): void {
        this.player.send(new TradePacketPacket(Opcodes.Trade.Accept, { message }));
    }

    /**
     * Callback for when the inventory is loaded. Relay message to the client.
     */

    private handleInventory(): void {
        // Send Batch packet to the client.
        this.player.send(
            new ContainerPacket(Opcodes.Container.Batch, {
                type: Modules.ContainerType.Inventory,
                data: this.player.inventory.serialize(true)
            })
        );
    }

    /**
     * Callback for when the bank is loaded. Relay message to the client.
     */

    private handleBank(): void {
        // Send Batch packet to the client.
        this.player.send(
            new ContainerPacket(Opcodes.Container.Batch, {
                type: Modules.ContainerType.Bank,
                data: this.player.bank.serialize(true)
            })
        );
    }

    /**
     * Sends a packet to the client whenever
     * we add an item in our inventory.
     * @param slot The slot we just added the item to.
     */

    private handleInventoryAdd(slot: Slot): void {
        this.player.send(
            new ContainerPacket(Opcodes.Container.Add, {
                type: Modules.ContainerType.Inventory,
                slot
            })
        );
    }

    /**
     * Send a packet to the client to clear the inventory slot.
     * @param slot The slot of the item we removed.
     * @param key The key of the slot we removed.
     * @param count The count represents the amount of item we are dropping, NOT IN THE SLOT.
     * @param enchantments The enchantments of the item we are dropping.
     * @param drop If the item should spawn in the world upon removal.
     */

    private handleInventoryRemove(
        slot: Slot,
        key: string,
        count: number,
        enchantments: Enchantments,
        drop?: boolean
    ): void {
        // Spawn the item in the world if drop is true, cheater accounts don't drop anything.
        if (drop && !this.player.isCheater() && !this.player.isHollowAdmin()) {
            let item = new Item(key, this.player.x, this.player.y, true, count, enchantments);

            // Pets spawn an entity, and items spawn in the world.
            if (item.isPetItem()) {
                if (this.player.hasPet()) return this.player.notify('misc:ALREADY_HAVE_PET');

                this.player.setPet(item.pet);
            } else this.world.entities.addItem(item);

            log.drop(`Player ${this.player.username} dropped ${count} ${key}.`);
        }

        this.player.send(
            new ContainerPacket(Opcodes.Container.Remove, {
                type: Modules.ContainerType.Inventory,
                slot: slot.serialize(true)
            })
        );
    }

    /**
     * Sends a packet to the client containing batch data for the quests.
     */

    private handleQuests(): void {
        this.player.send(new QuestPacket(Opcodes.Quest.Batch, this.player.quests?.serialize(true)));
    }

    /**
     * Sends a packet to the client containing batch data for the achievements.
     */

    private handleAchievements(): void {
        this.player.send(
            new AchievementPacket(
                Opcodes.Achievement.Batch,
                this.player.achievements?.serialize(true)
            )
        );
    }

    /**
     * Sends a packet to the server containing batch data
     * for the skills.
     */

    private handleSkills(): void {
        this.player.send(new SkillPacket(Opcodes.Skill.Batch, this.player.skills?.serialize(true)));
    }

    /**
     * Sends a packet to the client containing serialized abilities.
     */

    private handleAbilities(): void {
        this.player.send(
            new AbilityPacket(Opcodes.Ability.Batch, this.player.abilities?.serialize(true))
        );
    }

    /**
     * Sends a packet to the client whenever
     * we add an item in our bank.
     * @param slot The slot we just added the item to.
     */

    private handleBankAdd(slot: Slot): void {
        this.player.send(
            new ContainerPacket(Opcodes.Container.Add, {
                type: Modules.ContainerType.Bank,
                slot
            })
        );
    }

    /**
     * Callback sent to the client for when a slot is removed from the bank.
     * @param slot The slot of the bank we just removed data from.
     */

    private handleBankRemove(slot: Slot): void {
        this.player.send(
            new ContainerPacket(Opcodes.Container.Remove, {
                type: Modules.ContainerType.Bank,
                slot: slot.serialize(true)
            })
        );
    }

    /**
     * Callback for when the player's friends list finishes loading
     */

    private handleFriends(): void {
        this.player.send(
            new FriendsPacket(Opcodes.Friends.List, {
                list: this.player.friends?.getFriendsList()
            })
        );
    }

    /**
     * Callback for when a friend is added to the friends list.
     * @param username The username of the friend we just added.
     * @param status The online status of the friend we just added.
     * @param serverId The game world ID the friend is in.
     */

    private handleFriendsAdd(username: string, status: boolean, serverId: number): void {
        this.player.send(
            new FriendsPacket(Opcodes.Friends.Add, {
                username,
                status,
                serverId
            })
        );
    }

    /**
     * Callback for when a friend is removed from the friends list.
     */

    private handleFriendsRemove(username: string): void {
        this.player.send(
            new FriendsPacket(Opcodes.Friends.Remove, {
                username
            })
        );
    }

    /**
     * Synchronizes with the client the online status of a friend.
     * @param username The username of the friend we are updating.
     * @param status The online status of the friend we are updating.
     * @param serverId The game world ID the friend is in.
     */

    private handleFriendsStatus(username: string, status: boolean, serverId: number): void {
        this.player.send(
            new FriendsPacket(Opcodes.Friends.Status, {
                username,
                status,
                serverId
            })
        );
    }

    /**
     * Callback for when a player interacts with an NPC.
     * @param npc The NPC instance we are interacting with.
     */

    private handleTalkToNPC(npc: NPC): void {
        // Primarily for the prevention of packet injection.
        if (!this.player.isAdjacent(npc))
            return log.warning(
                `Player ${this.player.username} tried to talk to NPC ${npc.key} but is not adjacent.`
            );

        // Checks if the NPC has an active quest associated with it.
        let quest = this.player.quests.getQuestFromNPC(npc);

        if (quest) return quest.talkCallback?.(npc, this.player);

        // Checks if the NPC has an active achievement associated with it.
        let achievement = this.player.achievements.getAchievementFromEntity(npc);

        if (achievement) return achievement.talkCallback?.(npc, this.player);

        // NPC is a store.
        if (npc.store) return this.world.stores.open(this.player, npc);

        // Used to toggle interaction with the containers.
        if (npc.role === 'banker' || npc.role === 'enchanter')
            this.player.canAccessContainer = true;

        switch (npc.role) {
            case 'banker': {
                this.player.send(new NPCPacket(Opcodes.NPC.Bank, this.player.bank.serialize(true)));
                return;
            }
            case 'enchanter': {
                this.player.send(new NPCPacket(Opcodes.NPC.Enchant, {}));
                break;
            }
        }

        npc.talk(this.player);
    }

    /**
     * Callback for when a character instance is killed.
     * @param character A character instance, generally a player or a mob.
     */

    private handleKill(character: Character): void {
        // Have the minigame handle the kill if present.
        if (character.isPlayer()) {
            if (this.player.inMinigame()) this.player.getMinigame()?.kill(this.player);

            // Incremebt the pvp kill count.
            this.player.statistics.pvpKills++;
        }

        // Skip if the kill is not a mob entity.
        if (!character.isMob()) return;

        // Add the mob kill to the player's statistics.
        this.player.statistics.addMobKill(character.key);

        /**
         * Special mobs (such as minibosses and bosses) have achievements
         * associated with them. Upon killing them, we complete the achievement.
         */

        let mobAchievement = character.achievement;

        if (mobAchievement) this.player.achievements.get(mobAchievement).finish();

        // Checks if the mob has a active quest associated with it.
        let quest = this.player.quests.getQuestFromMob(character);

        if (quest) quest.killCallback?.(character);

        // Checks if the mob has an active achievement associated with it.
        let achievement = this.player.achievements.getAchievementFromEntity(character);

        if (achievement) achievement.killCallback?.(character);
    }

    /**
     * Callback for when the player's poison status updates.
     */

    private handlePoison(type = -1, exists = false): void {
        // Notify the player when the poison status changes.
        if (type === -1) this.player.notify('misc:POISONED');
        else if (exists) this.player.notify('misc:POISON_WORN_OFF');

        this.player.send(new PoisonPacket(type));
    }

    /**
     * Callback for when the cheat score updates.
     */

    private handleCheatScore(): void {
        /**
         * This is a primitive anti-cheating system.
         * It will not accomplish much, but it is enough for now.
         */

        if (this.player.cheatScore > 15) {
            this.player.sendToSpawn();

            this.player.connection.reject('cheating');
        }

        log.general(`[${this.player.username}] Cheat score: ${this.player.cheatScore}`);
    }

    /**
     * Callback for when a change in player's mana has occurred.
     */

    private handleMana(): void {
        this.player.send(
            new PointsPacket({
                instance: this.player.instance,
                mana: this.player.mana.getMana(),
                maxMana: this.player.mana.getMaxMana()
            })
        );
    }

    /**
     * Sends the player the lights in the nearby regions.
     * @param regionId Identifier of the region we just entered.
     */

    private handleLights(region: number): void {
        if (region < 0) return;

        this.map.regions.forEachSurroundingRegion(region, (regionId: number) => {
            let region = this.map.regions.get(regionId);

            region.forEachLight((light: Light) => {
                if (this.player.hasLoadedLight(light.id)) return;

                this.player.send(
                    new OverlayPacket(Opcodes.Overlay.Lamp, {
                        light: light.serialize()
                    })
                );

                this.player.lightsLoaded.push(light.id);
            });
        });
    }

    /**
     * Checks for the area the player is currently in at the given
     * `x` and `y` positions. Triggers an update in the player's area
     * state if it differs from the player's current state. (e.g. if
     * the player is not in a PVP area and enters a PVP area, the player's
     * current state differs from the position's state, so the player's
     * state is updated and relayed to the client).
     * @param x The x grid coordinate we are checking the area at.
     * @param y The y grid coordinate we are checking the area at.
     */

    private detectAreas(x: number, y: number): void {
        this.map.forEachAreas(
            (areas: Areas, name: string) => {
                let info = areas.inArea(x, y);

                switch (name) {
                    case 'pvp': {
                        return this.player.updatePVP(!!info);
                    }

                    case 'overlay': {
                        return this.player.updateOverlay(info);
                    }

                    case 'camera': {
                        return this.player.updateCamera(info);
                    }

                    case 'music': {
                        return this.player.updateMusic(info);
                    }

                    case 'minigame': {
                        return this.player.updateMinigame(info);
                    }
                }
            },
            ['pvp', 'music', 'overlay', 'camera', 'minigame']
        );
    }

    /**
     * Whenever a player's position updates, we check if the nearby entities
     * can aggro the player. See `canAggro` in `Mob` for conditions under
     * which a player will be aggroed by a free-roaming mob.
     */

    private detectAggro(): void {
        let region = this.map.regions.get(this.player.region);

        region.forEachEntity((entity: Entity) => {
            // Ignore non-mob entities.
            if (!entity.isMob()) return;

            // Check if the mob can aggro the player and initiate the combat.
            if (entity.canAggro(this.player)) entity.combat.attack(this.player);
        });
    }

    /**
     * Takes a `interval` value and modulos it against the current updateTicks.
     * This is to separate an event into a larger interval instead of starting
     * multiple `setInterval` functions. For example, an `interval` of 4 means
     * that the event is called every 4 ticks (or 2400 milliseconds if `updateTime`
     * is set to 600 milliseconds).
     * @param interval The modulo interval.
     * @returns Whether or not the `interval` is reached.
     */

    private isTickInterval(interval: number): boolean {
        return this.updateTicks % interval === 0;
    }

    /**
     * Clears the timeouts and nullifies them (used for disconnection);
     */

    public clear(): void {
        clearInterval(this.updateInterval!);
        this.updateInterval = null;

        clearInterval(this.player.readyTimeout!);
        this.player.readyTimeout = null;
    }
}
