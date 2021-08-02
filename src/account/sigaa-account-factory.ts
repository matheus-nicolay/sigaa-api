import { BondFactory } from '@bonds/sigaa-bond-factory';
import { Parser } from '@helpers/sigaa-parser';
import { HTTP } from '@session/sigaa-http';
import { Page } from '@session/sigaa-page';
import { Session } from '@session/sigaa-session';
import { Account } from './sigaa-account';
import { SigaaAccountIFSC } from './sigaa-account-ifsc';
import { SigaaAccountUFPB } from './sigaa-account-ufpb';
import { SigaaAccountIFFAR } from './sigaa-account-iffar';

/**
 * Abstraction to represent the class that instantiates the account.
 * @category Internal
 */
export interface AccountFactory {
  /**
   * Creates a new instance of Account.
   * @param page home page of account (page after login).
   */
  getAccount(page: Page): Promise<Account>;
}

/**
 *
 * Serves to create account instances.
 * @category Internal
 */
export class SigaaAccountFactory implements AccountFactory {
  constructor(
    private http: HTTP,
    private parser: Parser,
    private session: Session,
    private bondFactory: BondFactory
  ) {}
  /**
   * Creates a new instance of Account.
   * @param page home page of account (page after login).
   */
  async getAccount(page: Page): Promise<Account> {
    if (this.session.institution === 'UFPB') {
      return new SigaaAccountUFPB(
        page,
        this.http,
        this.parser,
        this.session,
        this.bondFactory
      );
    } else if(this.session.institution === 'IFFAR'){
      return new SigaaAccountIFFAR(
        page,
        this.http,
        this.parser,
        this.session,
        this.bondFactory
      );
    }else {
      return new SigaaAccountIFSC(
        page,
        this.http,
        this.parser,
        this.session,
        this.bondFactory
      );
    }
  }
}
