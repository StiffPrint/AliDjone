import {usersGet,mutateRequest} from '../../../lib/web-store';
export const GET=usersGet;
export const POST=(r:Request)=>mutateRequest(r,true);
