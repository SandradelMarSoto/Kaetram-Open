import { Modules } from '@kaetram/common/network';

import Skill from '../skill';

export default class Magic extends Skill {
    public override combat = true;

    public constructor() {
        super(Modules.Skills.Magic);
    }
}